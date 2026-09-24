import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Chief note reminder", () => {
  it.live(
    "attaches only exact active pending IDs to an existing goal dispatch",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const sessions = {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">
        const goals = RayaGoal.make({ storage, sessions })
        const ledger = ChiefBranches.make(storage)
        const seed = () =>
          Effect.gen(function* () {
            const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
            const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
            const input = MessageID.make(`msg_${crypto.randomUUID()}`)
            const goal = yield* goals.create(id, "Finish the two independent audits")
            yield* Effect.addFinalizer(() =>
              Effect.all([goals.clear(id), storage.remove(["raya", "chief", "branches", id])]).pipe(Effect.ignore),
            )
            const plan = yield* ledger.start({
              goalID: id,
              goalCreatedAt: goal.createdAt,
              requestID: `msg_${crypto.randomUUID()}`,
              branches: [
                {
                  id: "audit",
                  name: "Safety audit",
                  specialist: "researcher",
                  access: "read",
                  brief: { objective: "Audit safety", constraints: [], expectedReturn: "Findings" },
                },
                {
                  id: "design",
                  name: "UX audit",
                  specialist: "designer",
                  access: "read",
                  brief: { objective: "Audit UX", constraints: [], expectedReturn: "Findings" },
                },
              ],
            })
            yield* ledger.admit({
              goalID: id,
              goalCreatedAt: goal.createdAt,
              branchID: "audit",
              callID: "task-audit",
              sessionID: child,
              messageID: input,
              access: "read",
            })
            const note = yield* ledger.note({
              goalID: id,
              goalCreatedAt: goal.createdAt,
              requestID: plan.requestID,
              branchID: "audit",
              taskCallID: "task-audit",
              childSessionID: child,
              childMessageID: input,
              senderMessageID: MessageID.make(`msg_${crypto.randomUUID()}`),
              toolCallID: "call-note",
              text: "Untrusted child text must not enter the reminder",
            })
            return { id, note, plan }
          })
        const active = yield* seed()
        const calls: { id: MessageID; note?: string }[] = []
        yield* RayaGoalContinuation.resume({
          sessionID: active.id,
          storage,
          sessions,
          run: async (_session, _objective, _directory, id, _queued, _signal, _files, _completion, note) => {
            calls.push({ id, note })
          },
        })
        expect(calls).toHaveLength(1)
        const dispatched = (yield* goals.get(active.id))?.dispatch?.messageID
        if (!dispatched) throw new Error("Expected a saved goal dispatch")
        expect(calls[0]?.id).toBe(dispatched)
        expect(calls[0]?.note).toContain(active.note.id)
        expect(calls[0]?.note).toContain("chief_inspect")
        expect(calls[0]?.note).toContain("not completed task results")
        expect(calls[0]?.note).not.toContain(active.note.text)
        expect(
          (yield* ledger.pending({
            goalID: active.id,
            goalCreatedAt: active.plan.goalCreatedAt,
            requestID: active.plan.requestID,
            revision: active.plan.revision,
          })).map((item) => item.id),
        ).toEqual([active.note.id])
        yield* RayaGoalContinuation.resume({
          sessionID: active.id,
          storage,
          sessions,
          run: async () => {
            throw new Error("A started dispatch must not start a second turn for the reminder")
          },
        })
        expect(calls).toHaveLength(1)

        const stale = yield* seed()
        yield* goals.revise(stale.id, "A revised direction")
        yield* RayaGoalContinuation.resume({
          sessionID: stale.id,
          storage,
          sessions,
          run: async (_session, _objective, _directory, id, _queued, _signal, _files, _completion, note) => {
            calls.push({ id, note })
          },
        })
        expect(calls).toHaveLength(2)
        expect(calls[1]?.note).toBeUndefined()

        const paused = yield* seed()
        yield* goals.control(paused.id, "paused")
        yield* RayaGoalContinuation.resume({
          sessionID: paused.id,
          storage,
          sessions,
          run: async () => {
            throw new Error("Paused goal must not dispatch")
          },
        })
        expect((yield* goals.get(paused.id))?.status).toBe("paused")
      }),
    30_000,
  )
})
