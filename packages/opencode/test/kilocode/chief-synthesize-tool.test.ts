import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import type { RayaGoal } from "@/kilocode/goal"
import { chiefSynthesizeTool } from "@/kilocode/tool/chief-synthesize"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

describe("Auto Chief branch synthesis", () => {
  it.live("binds a complete synthesis to the active saved request", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const request = MessageID.make(`msg_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      const raw = { createdAt, status: "active", dispatch: { messageID: request } }
      const state = raw as RayaGoal.State
      yield* storage.replace(["raya", "goal", id], state)
      yield* Effect.addFinalizer(() =>
        Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
          Effect.ignore,
        ),
      )
      const ledger = ChiefBranches.make(storage)
      const saved = yield* ledger.start({
        goalID: id,
        goalCreatedAt: createdAt,
        requestID: request,
        branches: [
          {
            id: "safety",
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
      const parent = { metadata: { [RayaChief.phaseKey]: "task" } } as unknown as Session.Info
      const sessions = { get: () => Effect.succeed(parent) } as Pick<Session.Interface, "get">
      const agents = { get: () => Effect.succeed({}) } as unknown as Agent.Interface
      const truncate = {
        output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface
      const tool = yield* chiefSynthesizeTool({
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
      const input = {
        summary: "Safety and UX findings are ready.",
        findings: [
          { branch_id: "safety", conclusion: "Safety evidence is sound." },
          { branch_id: "design", conclusion: "UX findings are sound." },
        ],
      }
      expect(Exit.isFailure(yield* def.execute(input, ctx).pipe(Effect.exit))).toBe(true)
      yield* storage.replace(["raya", "chief", "branches", id], {
        ...saved,
        branches: saved.branches.map((item) => ({
          ...item,
          state: "completed",
          review: { callID: "read", messageID: "msg", partID: "part", at: Date.now() },
        })),
      })
      expect(
        Exit.isFailure(yield* def.execute({ ...input, findings: [input.findings[0]] }, ctx).pipe(Effect.exit)),
      ).toBe(true)
      const result = yield* def.execute(input, ctx)
      expect(result.output).toContain("Safety and UX findings are ready.")
      expect((yield* ledger.read(id))?.synthesis?.findings.map((item) => item.branchID)).toEqual(["safety", "design"])
      parent.metadata![RayaChief.phaseKey] = "route"
      expect(Exit.isFailure(yield* def.execute(input, ctx).pipe(Effect.exit))).toBe(true)
      parent.metadata![RayaChief.phaseKey] = "task"
      raw.dispatch.messageID = MessageID.make(`msg_${crypto.randomUUID()}`)
      expect(Exit.isFailure(yield* def.execute(input, ctx).pipe(Effect.exit))).toBe(true)
    }),
  )
})
