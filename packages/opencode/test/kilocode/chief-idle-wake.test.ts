import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import type { Session } from "@/session/session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import type { Bus } from "@/bus"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Chief idle attention", () => {
  it.live(
    "prepares a pending batch only at idle and dispatches it once with a stable intake ID",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const rows: SessionV1.WithParts[] = []
        const session = { id, directory: process.cwd(), projectID: "test-project", metadata: {} }
        const sessions = {
          get: () => Effect.succeed(session),
          messages: () => Effect.succeed(rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">
        const goals = RayaGoal.make({ storage, sessions })
        const ledger = ChiefBranches.make(storage)
        const goal = yield* goals.create(id, "Review both specialist findings")
        yield* Effect.addFinalizer(() =>
          Effect.all([goals.clear(id), storage.remove(["raya", "chief", "branches", id])]).pipe(Effect.ignore),
        )
        const plan = yield* ledger.start({
          goalID: id,
          goalCreatedAt: goal.createdAt,
          requestID: `msg_${crypto.randomUUID()}`,
          branches: [
            {
              id: "safety",
              name: "Safety",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Audit safety", constraints: [], expectedReturn: "Findings" },
            },
            {
              id: "design",
              name: "Design",
              specialist: "designer",
              access: "read",
              brief: { objective: "Audit design", constraints: [], expectedReturn: "Findings" },
            },
          ],
        })
        const input = MessageID.ascending()
        yield* ledger.admit({
          goalID: id,
          goalCreatedAt: goal.createdAt,
          branchID: "safety",
          callID: "task-safety",
          sessionID: child,
          messageID: input,
          access: "read",
        })
        const note = yield* ledger.note({
          goalID: id,
          goalCreatedAt: goal.createdAt,
          requestID: plan.requestID,
          branchID: "safety",
          taskCallID: "task-safety",
          childSessionID: child,
          childMessageID: input,
          senderMessageID: MessageID.ascending(),
          toolCallID: "call-note",
          text: "This untrusted child text must not become a prompt",
        })
        const previous = MessageID.ascending()
        const assistant = MessageID.ascending()
        yield* storage.replace(["raya", "goal", id], {
          ...goal,
          revision: crypto.randomUUID(),
          dispatch: {
            id: crypto.randomUUID(),
            messageID: previous,
            intent: goal.intent ?? "unset",
            phase: "finished",
            queuedAt: Date.now() - 1_000,
            finishedAt: Date.now() - 500,
            assistantID: assistant,
            outcome: "completed",
          },
          accounted: { userID: previous, messages: [assistant] },
        })
        const calls: { id: MessageID; note?: string }[] = []
        let idle = false
        const run = async (
          _session: SessionID,
          _objective: string,
          _directory: string,
          messageID: MessageID,
          _queued: number,
          _signal: AbortSignal,
          _files?: readonly SessionV1.FilePartInput[],
          _completion?: "reply",
          text?: string,
        ) => {
          calls.push({ id: messageID, note: text })
          rows.push({
            info: { id: messageID, sessionID: id, role: "user", time: { created: Date.now() } },
            parts: [],
          } as unknown as SessionV1.WithParts)
        }
        const wake = () =>
          RayaGoalContinuation.wake({
            sessionID: id,
            directory: process.cwd(),
            projectID: session.projectID,
            storage,
            sessions,
            enabled: () => Effect.succeed(true),
            idle: () => Effect.succeed(idle),
            run,
          })
        expect(yield* wake()).toBe(false)
        expect((yield* ledger.read(id))?.attention?.prepared).toBeUndefined()
        let close:
          | ((event: { properties: { sessionID: SessionID; reason: "completed" } }) => Fiber.Fiber<unknown, unknown>)
          | undefined
        const bus = {
          subscribeCallback: (_event, callback) => {
            close = callback as typeof close
            return Effect.succeed(() => {})
          },
        } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
        yield* RayaGoalContinuation.subscribe({
          bus,
          storage,
          sessions,
          enabled: () => Effect.succeed(true),
          idle: () => Effect.succeed(idle),
          run,
        })
        if (!close) throw new Error("Missing parent turn-close subscriber")
        idle = true
        yield* Fiber.join(close({ properties: { sessionID: id, reason: "completed" } }))
        expect(calls).toHaveLength(1)
        yield* RayaGoalContinuation.restore({
          directory: process.cwd(),
          storage,
          sessions,
          enabled: () => Effect.succeed(true),
          idle: () => Effect.succeed(true),
          run: async () => {
            throw new Error("A partial saved intake must not replay a model turn")
          },
          loop: async () => {
            throw new Error("A partial saved intake must not resume an unknown model turn")
          },
        })
        expect(calls).toHaveLength(1)
        const running = yield* goals.get(id)
        if (!running?.dispatch?.attention?.batchID || !running.dispatch.messageID)
          throw new Error("Missing durable Chief attention origin")
        const reply = MessageID.ascending()
        yield* storage.replace(["raya", "goal", id], {
          ...running,
          revision: crypto.randomUUID(),
          dispatch: {
            ...running.dispatch,
            phase: "finished",
            finishedAt: Date.now(),
            assistantID: reply,
            outcome: "completed",
          },
          accounted: { userID: running.dispatch.messageID, messages: [reply] },
        })
        expect(yield* wake()).toBe(false)
        expect(calls).toHaveLength(1)
        const later = yield* ledger.note({
          goalID: id,
          goalCreatedAt: goal.createdAt,
          requestID: plan.requestID,
          branchID: "safety",
          taskCallID: "task-safety",
          childSessionID: child,
          childMessageID: input,
          senderMessageID: MessageID.ascending(),
          toolCallID: "call-later",
          text: "A later update",
        })
        const exact = JSON.stringify({
          requestID: plan.requestID,
          branches: [
            { id: "safety", notes: [note] },
            { id: "design", notes: [] },
          ],
        })
        const part = {
          id: "part-inspect",
          type: "tool",
          tool: "chief_inspect",
          callID: "call-inspect",
          state: {
            status: "completed",
            input: {},
            output: exact,
            metadata: { requestID: plan.requestID, goalCreatedAt: goal.createdAt },
            title: "Auto Chief branch results",
            time: { start: goal.createdAt, end: Date.now() + 1 },
          },
        }
        const receipt = {
          info: {
            id: reply,
            sessionID: id,
            parentID: previous,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
          },
          parts: [part],
        }
        rows.push(receipt as unknown as SessionV1.WithParts)
        expect(yield* wake()).toBe(false)
        receipt.info.parentID = running.dispatch.messageID
        part.state.output = JSON.stringify({
          requestID: plan.requestID,
          branches: [
            { id: "safety", notes: [{ ...note, text: "corrupted" }] },
            { id: "design", notes: [] },
          ],
        })
        expect(yield* wake()).toBe(false)
        expect(calls).toHaveLength(1)
        expect((yield* ledger.read(id))?.attention?.pending).toEqual([note.id, later.id])
        part.state.output = exact
        expect(yield* wake()).toBe(true)
        expect(calls).toHaveLength(2)
        expect((yield* ledger.read(id))?.attention?.pending).toEqual([later.id])
        expect((yield* ledger.read(id))?.attention?.prepared?.ids).toEqual([later.id])
        yield* goals.control(id, "paused")
        expect(yield* wake()).toBe(false)
        expect(calls).toHaveLength(2)
        expect(calls[0]?.note).toContain(note.id)
        expect(calls[0]?.note).toContain("chief_inspect")
        expect(calls[0]?.note).not.toContain(note.text)
        const saved = yield* goals.get(id)
        expect(saved?.dispatch?.attention?.ids).toEqual([later.id])
        expect(saved?.dispatch?.messageID).toBe(calls[1]?.id)
      }),
    30_000,
  )
})
