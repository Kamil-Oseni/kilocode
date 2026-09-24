import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefNotes } from "@/kilocode/chief/notes"
import type { RayaGoal } from "@/kilocode/goal"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Chief note readback", () => {
  it.live("returns one exact active plan's durable notes and refuses stale identities", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const childID = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const requestID = MessageID.make(`msg_${crypto.randomUUID()}`)
      const childMessageID = MessageID.make(`msg_${crypto.randomUUID()}`)
      const senderMessageID = MessageID.make(`msg_${crypto.randomUUID()}`)
      const goalCreatedAt = Date.now()
      const revisions: { id: string }[] = []
      const goal = { createdAt: goalCreatedAt, status: "active", revisions } as unknown as RayaGoal.State
      yield* storage.replace(["raya", "goal", sessionID], goal)
      yield* Effect.addFinalizer(() =>
        Effect.all([
          storage.remove(["raya", "goal", sessionID]),
          storage.remove(["raya", "chief", "branches", sessionID]),
        ]).pipe(Effect.ignore),
      )
      const ledger = ChiefBranches.make(storage)
      yield* ledger.start({
        goalID: sessionID,
        goalCreatedAt,
        requestID,
        branches: [
          {
            id: "audit",
            name: "Safety audit",
            specialist: "researcher",
            access: "read",
            brief: { objective: "Audit", constraints: [], expectedReturn: "Findings" },
          },
          {
            id: "design",
            name: "UX audit",
            specialist: "designer",
            access: "read",
            brief: { objective: "Design", constraints: [], expectedReturn: "Findings" },
          },
        ],
      })
      yield* ledger.admit({
        goalID: sessionID,
        goalCreatedAt,
        branchID: "audit",
        callID: "task-call",
        sessionID: childID,
        messageID: childMessageID,
        access: "read",
      })
      const plan = yield* ledger.read(sessionID)
      if (!plan || plan.version !== 2) throw new Error("Missing plan")
      revisions.push({ id: plan.revision })
      const note = yield* ledger.note({
        goalID: sessionID,
        goalCreatedAt,
        requestID,
        branchID: "audit",
        taskCallID: "task-call",
        childSessionID: childID,
        childMessageID,
        senderMessageID,
        toolCallID: "note-call",
        text: "Audit in progress",
      })
      const parent = { id: sessionID, projectID: "project-a", directory: "C:\\parent-worktree" } as Session.Info
      const deps = {
        storage,
        goals: { get: () => Effect.succeed(goal) } as Pick<ReturnType<typeof RayaGoal.make>, "get">,
        sessions: { get: () => Effect.succeed(parent) } as Pick<Session.Interface, "get">,
        context: { directory: parent.directory, project: { id: parent.projectID } },
      }
      const input = { sessionID, goalCreatedAt, requestID, revision: plan.revision }
      const first = yield* ChiefNotes.read(input, deps)
      expect(first.notes).toEqual([
        {
          version: 1,
          id: note.id,
          branchID: "audit",
          branchName: "Safety audit",
          childSessionID: childID,
          text: "Audit in progress",
          at: note.at,
          state: "delivered",
        },
      ])
      expect((yield* ChiefNotes.read(input, deps)).notes).toEqual(first.notes)
      expect(
        Exit.isFailure(
          yield* ChiefNotes.read({ ...input, sessionID: SessionID.make("ses_other") }, deps).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* ChiefNotes.read({ ...input, requestID: "msg_other" }, deps).pipe(Effect.exit))).toBe(
        true,
      )
      expect(Exit.isFailure(yield* ChiefNotes.read({ ...input, revision: "stale" }, deps).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* ChiefNotes.read({ ...input, goalCreatedAt: goalCreatedAt - 1 }, deps).pipe(Effect.exit)),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* ChiefNotes.read(input, {
            ...deps,
            context: { directory: "C:\\other-worktree", project: { id: parent.projectID } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* ChiefNotes.read(input, {
            ...deps,
            context: { directory: parent.directory, project: { id: "project-b" } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* ChiefNotes.read(input, {
            ...deps,
            goals: { get: () => Effect.succeed({ ...goal, status: "paused" }) } as Pick<
              ReturnType<typeof RayaGoal.make>,
              "get"
            >,
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )
})
