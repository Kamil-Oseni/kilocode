import { expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineAttachmentTable as Attachment,
  RayaRoutineConversationTable as Conversation,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { tmpdir } from "../../fixture/fixture"

test("routine draft owner, incarnation and exact SQL base survive a database restart", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "raya.db")
  const profile = { database: filename, storage: path.join(directory.path, "storage") }
  const file = {
    id: "2c6b2156-835d-4c44-a8db-8698bd2e318a",
    name: "brief.txt",
    mime: "text/plain",
    size: 5,
    data: Buffer.from("brief").toString("base64"),
  }
  const saved = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database, profile)
      const absent = yield* inbox
        .draft("worker", {
          owner: "rpo_" + "0".repeat(48),
          conversationID: "rcv_absent",
          expectedRevision: 0,
          draft: "must not initialize",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(absent)).toBe(true)
      expect(yield* database.db.select().from(Conversation).where(eq(Conversation.agent_id, "worker")).get()).toBeUndefined()

      const initial = (yield* inbox.page("worker")).draftState
      expect(initial.revision).toBe(0)
      expect(initial.owner.startsWith("rpo_")).toBe(true)
      expect(initial.owner).not.toContain(directory.path)
      const written = yield* inbox.draft("worker", {
        owner: initial.owner,
        conversationID: initial.conversationID,
        expectedRevision: initial.revision,
        draft: "Read the brief",
        attachments: [file],
      })
      expect(written.revision).toBe(1)
      expect(written.attachments?.map((item) => item.id)).toEqual([file.id])
      return written
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database, profile)
      expect((yield* inbox.page("worker")).draftState).toEqual(saved)
      const foreign = RayaTaskInbox.make(database, { ...profile, storage: path.join(directory.path, "other") })
      expect((yield* foreign.page("worker")).draftState.owner).not.toBe(saved.owner)
      expect(
        Exit.isFailure(
          yield* foreign
            .draft("worker", {
              owner: saved.owner,
              conversationID: saved.conversationID,
              expectedRevision: saved.revision,
              draft: "foreign storage root",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const request = { owner: saved.owner, conversationID: saved.conversationID, expectedRevision: 0 }
      expect(
        Exit.isFailure(
          yield* inbox.draft("worker", { ...request, owner: "rpo_" + "0".repeat(48), draft: "wrong owner" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* inbox.draft("worker", { ...request, conversationID: "rcv_wrong", draft: "wrong row" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* inbox.draft("worker", { ...request, draft: "stale divergent" }).pipe(Effect.exit))).toBe(true)
      expect(
        yield* inbox.draft("worker", { ...request, draft: "Read the brief", attachmentIDs: [file.id] }),
      ).toEqual(saved)
      expect((yield* database.db.select().from(Attachment).where(eq(Attachment.agent_id, "worker")).all())).toHaveLength(1)
      const cleared = yield* inbox.draft("worker", {
        owner: saved.owner,
        conversationID: saved.conversationID,
        expectedRevision: saved.revision,
        draft: null,
        attachmentIDs: [],
      })
      expect(cleared).toEqual({ owner: saved.owner, conversationID: saved.conversationID, draft: null, revision: 2 })
      expect((yield* database.db.select().from(Attachment).where(eq(Attachment.agent_id, "worker")).all())).toEqual([])
      expect(Exit.isFailure(yield* inbox.draft("worker", { ...request, draft: "Read the brief" }).pipe(Effect.exit))).toBe(true)
      yield* database.db.delete(Conversation).where(eq(Conversation.agent_id, "worker")).run()
      const next = (yield* inbox.page("worker")).draftState
      expect(next.conversationID).not.toBe(saved.conversationID)
      expect(next.owner).toBe(saved.owner)
      expect(next.revision).toBe(0)
      expect(
        Exit.isFailure(
          yield* inbox
            .draft("worker", {
              owner: saved.owner,
              conversationID: saved.conversationID,
              expectedRevision: 0,
              draft: "old incarnation",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect((yield* inbox.page("worker")).draftState).toEqual(next)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
})

test("routine send validates the flushed SQL revision before admitting work or moving files", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "raya.db")
  const profile = { database: filename, storage: path.join(directory.path, "storage") }
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database, profile)
      const initial = (yield* inbox.page("worker")).draftState
      const file = {
        id: "85292fca-e188-44b2-b3bb-ff23408b2433",
        name: "brief.txt",
        mime: "text/plain",
        size: 5,
        data: Buffer.from("brief").toString("base64"),
      }
      const ready = yield* inbox.draft("worker", {
        owner: initial.owner,
        conversationID: initial.conversationID,
        expectedRevision: initial.revision,
        draft: "Read the brief",
        attachments: [file],
      })
      const input = {
        agentID: "worker",
        source: "user_flushed",
        kind: "user" as const,
        body: "Read the brief",
        attachmentIDs: [file.id],
      }
      const proof = { owner: ready.owner, conversationID: ready.conversationID, expectedRevision: ready.revision }
      expect(Exit.isFailure(yield* inbox.admit(input, { ...proof, expectedRevision: 0 }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* inbox.admit(input, { ...proof, conversationID: "rcv_wrong" }).pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Message).where(eq(Message.agent_id, "worker")).all())).toEqual([])
      expect((yield* inbox.page("worker")).draftState).toEqual(ready)
      expect((yield* database.db.select().from(Attachment).where(eq(Attachment.agent_id, "worker")).get())?.message_id).toBeNull()

      const sent = yield* inbox.admit(input, proof)
      expect(sent.created).toBe(true)
      expect(sent.record.attachments?.map((item) => item.id)).toEqual([file.id])
      const after = (yield* inbox.page("worker")).draftState
      expect(after.draft).toBeNull()
      expect(after.revision).toBe(ready.revision + 1)
      const later = yield* inbox.draft("worker", {
        owner: after.owner,
        conversationID: after.conversationID,
        expectedRevision: after.revision,
        draft: "A different next message",
      })
      expect(yield* inbox.admit(input, proof)).toEqual({ record: sent.record, created: false })
      expect((yield* inbox.page("worker")).draftState).toEqual(later)

      yield* database.db.delete(Conversation).where(eq(Conversation.agent_id, "worker")).run()
      const replaced = (yield* inbox.page("worker")).draftState
      expect(replaced.conversationID).not.toBe(ready.conversationID)
      expect(Exit.isFailure(yield* inbox.admit({ ...input, source: "user_late" }, proof).pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Message).where(eq(Message.agent_id, "worker")).all())).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
})
