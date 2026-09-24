import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Agent } from "@/agent/agent"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import type { RayaGoal } from "@/kilocode/goal"
import { chiefMessageTool } from "@/kilocode/tool/chief-message"
import { chiefInspectTool } from "@/kilocode/tool/chief-inspect"
import { TaskName } from "@/kilocode/tool/task-name"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Chief child notes", () => {
  it.live(
    "saves one bounded note, survives restart, and refuses changed identity or a duplicate with different text",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const parentID = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
        const childID = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const inputID = MessageID.make(`msg_${crypto.randomUUID()}`)
        const replyID = MessageID.make(`msg_${crypto.randomUUID()}`)
        const requestID = MessageID.make(`msg_${crypto.randomUUID()}`)
        const createdAt = Date.now()
        const state = { createdAt, status: "active", revisions: [] as { id: string }[] } as unknown as RayaGoal.State
        yield* storage.replace(["raya", "goal", parentID], state)
        yield* Effect.addFinalizer(() =>
          Effect.all([
            storage.remove(["raya", "goal", parentID]),
            storage.remove(["raya", "chief", "branches", parentID]),
          ]).pipe(Effect.ignore),
        )
        const ledger = ChiefBranches.make(storage)
        yield* ledger.start({
          goalID: parentID,
          goalCreatedAt: createdAt,
          requestID,
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
          goalID: parentID,
          goalCreatedAt: createdAt,
          branchID: "audit",
          callID: "call-task",
          sessionID: childID,
          messageID: inputID,
          access: "read",
        })
        const identity = TaskName.allocate({
          description: "Safety audit",
          specialist: "researcher",
          selection: "auto",
          parentSessionID: parentID,
          parentMessageID: requestID,
          callID: "call-task",
          siblings: [],
        })
        const parent = { id: parentID, metadata: { [RayaChief.phaseKey]: "task" } } as unknown as Session.Info
        const child = { id: childID, parentID, metadata: { [TaskName.key]: identity } } as unknown as Session.Info
        const rows = [
          { info: { id: inputID, role: "user", time: { created: 0 } }, parts: [] },
          {
            info: { id: replyID, role: "assistant", time: { created: 1 } },
            parts: [
              { type: "tool", tool: "chief_message", callID: "call-note", state: { status: "running" } },
              { type: "tool", tool: "chief_message", callID: "call-unknown", state: { status: "running" } },
            ],
          },
        ] as unknown as SessionV1.WithParts[]
        const sessions = {
          get: (id: SessionID) => Effect.succeed(id === parentID ? parent : child),
          messages: () => Effect.succeed(rows),
        } as Pick<Session.Interface, "get" | "messages">
        const agents = { get: () => Effect.succeed({}) } as unknown as Agent.Interface
        const truncate = {
          output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
        } as Truncate.Interface
        const tool = yield* chiefMessageTool({
          storage,
          sessions,
          goals: { get: () => Effect.succeed(state) } as Pick<ReturnType<typeof RayaGoal.make>, "get">,
        }).pipe(Effect.provideService(Agent.Service, agents), Effect.provideService(Truncate.Service, truncate))
        const def = yield* tool.init()
        const ctx = {
          sessionID: childID,
          messageID: replyID,
          callID: "call-note",
          agent: "researcher",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const workerContext = { directory: "C:\\isolated-chief-child" } as unknown as InstanceContext
        const parentContext = { directory: "C:\\parent-worktree" } as unknown as InstanceContext
        const first = yield* def
          .execute({ text: "Read-only audit is underway." }, ctx)
          .pipe(Effect.provideService(InstanceRef, workerContext))
        expect(first.metadata.state).toBe("delivered")
        const retry = yield* def.execute({ text: "Read-only audit is underway." }, ctx)
        expect(retry.metadata.receipt).toEqual(first.metadata.receipt)
        const restarted = yield* ChiefBranches.make(storage).read(parentID)
        expect(restarted?.notes).toHaveLength(1)
        expect(restarted?.notes?.[0]).toMatchObject({
          requestID,
          goalCreatedAt: createdAt,
          branchID: "audit",
          taskCallID: "call-task",
          childSessionID: childID,
          childMessageID: inputID,
          text: "Read-only audit is underway.",
        })
        expect((yield* def.execute({ text: "Changed content" }, ctx)).metadata.state).toBe("refused")
        expect((yield* def.execute({ text: "Note" }, { ...ctx, agent: "designer" })).metadata.state).toBe("refused")
        expect(
          (yield* def.execute({ text: "Note" }, { ...ctx, sessionID: SessionID.make("ses_other") })).metadata.state,
        ).toBe("refused")
        expect((yield* def.execute({ text: "Note" }, { ...ctx, callID: "call_other" })).metadata.state).toBe("refused")
        expect(
          (yield* def.execute({ text: "Note" }, { ...ctx, sessionID: parentID, agent: "researcher" })).metadata.state,
        ).toBe("refused")
        const inspector = yield* chiefInspectTool({
          storage,
          sessions,
          goals: { get: () => Effect.succeed(state) } as Pick<ReturnType<typeof RayaGoal.make>, "get">,
        }).pipe(Effect.provideService(Agent.Service, agents), Effect.provideService(Truncate.Service, truncate))
        const inspected = yield* (yield* inspector.init())
          .execute({}, { ...ctx, sessionID: parentID, agent: "auto", messageID: requestID })
          .pipe(Effect.provideService(InstanceRef, parentContext))
        const report = JSON.parse(inspected.output) as { branches: { id: string; notes: ChiefBranches.Note[] }[] }
        expect(report.branches.find((item) => item.id === "audit")?.notes).toEqual([...(restarted?.notes ?? [])])
        expect(report.branches.find((item) => item.id === "design")?.notes).toEqual([])
        const faulty = { ...storage, replace: () => Effect.die(new Error("write outcome unavailable")) }
        const uncertain = yield* chiefMessageTool({
          storage: faulty,
          sessions,
          goals: { get: () => Effect.succeed(state) } as Pick<ReturnType<typeof RayaGoal.make>, "get">,
        }).pipe(Effect.provideService(Agent.Service, agents), Effect.provideService(Truncate.Service, truncate))
        const attempt = yield* (yield* uncertain.init()).execute(
          { text: "Unconfirmed note" },
          { ...ctx, callID: "call-unknown" },
        )
        expect(attempt.metadata.state).toBe("unknown")
        expect((yield* ChiefBranches.make(storage).read(parentID))?.notes).toHaveLength(1)
        for (let index = 2; index <= 8; index++) {
          yield* ledger.note({
            goalID: parentID,
            goalCreatedAt: createdAt,
            requestID,
            branchID: "audit",
            taskCallID: "call-task",
            childSessionID: childID,
            childMessageID: inputID,
            senderMessageID: MessageID.make(`msg_note_${index}`),
            toolCallID: `call-note-${index}`,
            text: `Update ${index}`,
          })
        }
        expect((yield* ledger.read(parentID))?.notes).toHaveLength(8)
        const overflow = yield* ledger
          .note({
            goalID: parentID,
            goalCreatedAt: createdAt,
            requestID,
            branchID: "audit",
            taskCallID: "call-task",
            childSessionID: childID,
            childMessageID: inputID,
            senderMessageID: MessageID.make("msg_note_9"),
            toolCallID: "call-note-9",
            text: "Update 9",
          })
          .pipe(Effect.exit)
        expect(overflow._tag).toBe("Failure")
        yield* storage.replace(["raya", "goal", parentID], { ...state, createdAt: createdAt + 1 })
        expect((yield* def.execute({ text: "Note" }, ctx)).metadata.state).toBe("refused")
      }),
  )
})
