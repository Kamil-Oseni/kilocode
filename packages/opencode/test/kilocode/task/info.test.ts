import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Exit } from "effect"
import type { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskInfo, type Identity } from "@/kilocode/task/info"
import { SessionID } from "@/session/schema"

const agent = (id: string, name: string, role: string): RayaTask.Agent => ({
  id,
  name,
  role,
  objective: `${name} standing work`,
  capabilities: role === "accountant" ? ["accounting"] : [],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  access: "full",
})

test("routine chat info pages only persisted files and http links with message provenance", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database)
      const info = RayaTaskInfo.make(database)
      const message = yield* inbox.publish({
        agentID: "books",
        source: "report:friday",
        kind: "report",
        body: "Review https://example.com/close, then http://reports.test/q3. Ignore ftp://private.test.",
        occurrenceID: "run_friday",
        sessionID: SessionID.make("ses_friday"),
        files: [
          { name: "ledger.pdf", path: "reports/ledger.pdf" },
          { name: "receipts.csv", path: "reports/receipts.csv" },
        ],
      })
      const first = yield* info.shares("books", undefined, 2)
      expect(first.section).toBe("shares")
      expect(first.items.map((item) => item.kind)).toEqual(["file", "file"])
      expect(first.items.every((item) => item.messageID === message.id && item.source === "report:friday")).toBe(true)
      expect(first.items.every((item) => item.occurrenceID === "run_friday" && item.sessionID === "ses_friday")).toBe(
        true,
      )
      expect(first.next).toBeDefined()
      const second = yield* info.shares("books", first.next, 2)
      expect(second.items.map((item) => (item.kind === "link" ? item.url : undefined))).toEqual([
        "https://example.com/close",
        "http://reports.test/q3",
      ])
      expect(second.items.map((item) => item.label)).toEqual(["example.com", "reports.test"])
      expect(second.next).toBeUndefined()
      expect(Exit.isFailure(yield* info.shares("books", "wrong-section", 2).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* info.shares("books", undefined, 51).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine chat info includes user attachment metadata without stored content", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database)
      const info = RayaTaskInfo.make(database)
      const data = Buffer.from("private ledger").toString("base64")
      const message = yield* inbox.publish({
        agentID: "books",
        source: "user_attachment",
        kind: "user",
        body: "Review this ledger",
        sessionID: SessionID.make("ses_attachment"),
        attachments: [
          {
            id: "2564b7ed-998b-411d-aa41-e4414bb51111",
            name: "ledger.csv",
            mime: "text/csv",
            size: 14,
            data,
          },
        ],
      })
      const page = yield* info.shares("books")
      expect(page.items).toEqual([
        {
          kind: "attachment",
          attachmentID: "2564b7ed-998b-411d-aa41-e4414bb51111",
          label: "ledger.csv",
          mime: "text/csv",
          size: 14,
          messageID: message.id,
          messageKind: "user",
          source: "user_attachment",
          sessionID: SessionID.make("ses_attachment"),
          time: message.time,
        },
      ])
      expect(page.items[0]?.sessionID).toBe(SessionID.make("ses_attachment"))
      expect(JSON.stringify(page)).not.toContain(data)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine chat info continues bounded sparse share scans", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const inbox = RayaTaskInbox.make(database)
      const info = RayaTaskInfo.make(database)
      yield* inbox.publish({
        agentID: "books",
        source: "old_file",
        kind: "report",
        body: "Old report",
        files: [{ name: "old.pdf", path: "reports/old.pdf" }],
      })
      for (const n of Array.from({ length: 501 }, (_, index) => index))
        yield* inbox.publish({ agentID: "books", source: `plain_${n}`, kind: "worker", body: `Plain note ${n}` })
      const first = yield* info.shares("books")
      expect(first.items).toEqual([])
      expect(first.next).toBeDefined()
      const second = yield* info.shares("books", first.next)
      expect(second.items).toHaveLength(1)
      expect(second.items[0]).toMatchObject({ kind: "file", label: "old.pdf", path: "reports/old.pdf" })
      expect(second.next).toBeUndefined()
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine chat info pages durable sent and received delegation exchanges", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = RayaTaskDelegation.make(database)
      const info = RayaTaskInfo.make(database)
      const chief = agent("chief", "Chief of Staff", "generalist")
      const books = agent("books", "Accounting", "accountant")
      const legal = agent("legal", "Legal", "reviewer")
      const first = yield* store.admit(
        {
          source: "dlg_books",
          senderID: chief.id,
          recipientID: books.id,
          objective: "Reconcile Friday receipts.",
          expected: "List every missing receipt.",
          context: "The Friday close is due today.",
          parentRunID: "run_close",
          budget: 1000,
        },
        chief,
        books,
      )
      const taken = yield* store.take(books.id)
      yield* store.attach(taken!.id, "run_books", SessionID.make("ses_books"))
      yield* store.finish(first.record.id, "completed", books, "Three receipts are missing.", 1.25)
      yield* store.admit(
        { source: "dlg_legal", senderID: legal.id, recipientID: chief.id, objective: "Confirm the expense policy." },
        legal,
        chief,
      )
      const identities = new Map<string, Identity>([
        [books.id, { name: books.name, role: books.role, archived: true }],
        [legal.id, { name: legal.name, role: legal.role, archived: false }],
      ])
      const resolve = (id: string) => Effect.succeed(identities.get(id)!)
      const firstPage = yield* info.contacts(chief.id, resolve, undefined, 1)
      expect(firstPage.section).toBe("contacts")
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.next).toBeDefined()
      const secondPage = yield* info.contacts(chief.id, resolve, firstPage.next, 1)
      const items = [...firstPage.items, ...secondPage.items]
      expect(items.map((item) => item.direction).sort()).toEqual(["received", "sent"])
      expect(items.find((item) => item.peerID === books.id)).toMatchObject({
        name: "Accounting",
        role: "accountant",
        archived: true,
        direction: "sent",
        source: "dlg_books",
        state: "completed",
        expected: "List every missing receipt.",
        context: "The Friday close is due today.",
        parentRunID: "run_close",
        budget: 1000,
        response: "Three receipts are missing.",
        cost: 1.25,
        occurrenceID: "run_books",
        sessionID: "ses_books",
      })
      expect(items.find((item) => item.peerID === legal.id)).toMatchObject({
        name: "Legal",
        archived: false,
        direction: "received",
        source: "dlg_legal",
        state: "queued",
      })
      expect(secondPage.next).toBeUndefined()
      expect(Exit.isFailure(yield* info.contacts(chief.id, resolve, firstPage.next, 0).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
