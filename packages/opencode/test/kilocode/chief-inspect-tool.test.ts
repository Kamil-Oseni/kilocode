import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import type { RayaGoal } from "@/kilocode/goal"
import { chiefInspectTool } from "@/kilocode/tool/chief-inspect"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Auto Chief branch inspection", () => {
  it.live("shows the bounded final reply and exact child evidence without accepting the branch", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const user = MessageID.make(`msg_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      const raw = { createdAt, status: "active", dispatch: { messageID: user }, revisions: [] as { id: string }[] }
      const state = raw as unknown as RayaGoal.State
      yield* storage.replace(["raya", "goal", id], state)
      yield* Effect.addFinalizer(() =>
        Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
          Effect.ignore,
        ),
      )
      const branches = ChiefBranches.make(storage)
      yield* branches.start({
        goalID: id,
        goalCreatedAt: createdAt,
        requestID: user,
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
      yield* branches.admit({
        goalID: id,
        goalCreatedAt: createdAt,
        branchID: "audit",
        callID: "call-audit",
        sessionID: child,
        access: "read",
      })
      yield* branches.settle({
        goalID: id,
        goalCreatedAt: createdAt,
        branchID: "audit",
        callID: "call-audit",
        sessionID: child,
        state: "completed",
        result: "Child task completed",
      })
      const parent = { metadata: { [RayaChief.phaseKey]: "goal" } } as unknown as Session.Info
      const branch = { parentID: id } as Session.Info
      const rows = [
        {
          info: { id: "msg-tool", role: "assistant", time: { created: 1, completed: 2 } },
          parts: [{ id: "part-read", type: "tool", callID: "call-read", tool: "read", state: { status: "completed" } }],
        },
        {
          info: { id: "msg-final", role: "assistant", time: { created: 3, completed: 4 } },
          parts: [{ type: "text", text: "Confirmed the saved policy." }],
        },
      ] as unknown as SessionV1.WithParts[]
      const sessions = {
        get: (sessionID: SessionID) => Effect.succeed(sessionID === id ? parent : branch),
        messages: () => Effect.succeed(rows),
      } as Pick<Session.Interface, "get" | "messages">
      const agents = { get: () => Effect.succeed({}) } as unknown as Agent.Interface
      const truncate = {
        output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface
      const tool = yield* chiefInspectTool({
        storage,
        sessions,
        goals: { get: () => Effect.succeed(state) } as Pick<ReturnType<typeof RayaGoal.make>, "get">,
      }).pipe(Effect.provideService(Agent.Service, agents), Effect.provideService(Truncate.Service, truncate))
      const def = yield* tool.init()
      const ctx = {
        sessionID: id,
        messageID: MessageID.make(`msg_${crypto.randomUUID()}`),
        agent: "auto",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* def.execute({}, ctx)
      const view = JSON.parse(result.output)
      expect(view.branches[0]).toMatchObject({
        id: "audit",
        state: "completed",
        reviewed: false,
        report: "Confirmed the saved policy.",
        evidence: [{ messageID: "msg-tool", partID: "part-read", callID: "call-read", tool: "read" }],
      })
      expect(view.branches[1]).toMatchObject({ id: "design", state: "planned" })
      expect((yield* branches.read(id))?.branches[0]?.review).toBeUndefined()
      raw.dispatch.messageID = MessageID.make(`msg_${crypto.randomUUID()}`)
      expect(Exit.isFailure(yield* def.execute({}, ctx).pipe(Effect.exit))).toBe(false)
      raw.revisions.push({ id: crypto.randomUUID() })
      expect(Exit.isFailure(yield* def.execute({}, ctx).pipe(Effect.exit))).toBe(true)
    }),
  )
})
