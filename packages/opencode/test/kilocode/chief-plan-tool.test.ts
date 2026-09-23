import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import type { RayaGoal } from "@/kilocode/goal"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import { chiefPlanTool } from "@/kilocode/tool/chief-plan"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))
const request = "Audit Raya documentation and chat UX"
const proposals = [
  {
    id: "docs",
    name: "Documentation audit",
    specialist: "researcher",
    access: "read" as const,
    brief: { objective: "Inspect documentation", constraints: ["Do not edit"], expectedReturn: "Findings" },
    scope: ["documentation"],
    dependsOn: [],
    independence: "Uses only documentation.",
    authority: "Inspection is sufficient.",
  },
  {
    id: "chat",
    name: "Chat audit",
    specialist: "designer",
    access: "read" as const,
    brief: { objective: "Inspect chat UX", constraints: ["Do not edit"], expectedReturn: "Findings" },
    scope: ["chat"],
    dependsOn: [],
    independence: "Uses only chat code.",
    authority: "Inspection is sufficient.",
  },
]

describe("Auto Chief plan tool admission", () => {
  it.live("binds a validated plan to the saved user request without starting children", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
      const userID = MessageID.make(`msg_${crypto.randomUUID()}`)
      const createdAt = Date.now()
      const state = { createdAt, status: "active", dispatch: { messageID: userID } } as RayaGoal.State
      yield* storage.replace(["raya", "goal", id], state)
      yield* Effect.addFinalizer(() =>
        Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
          Effect.ignore,
        ),
      )
      const metadata = { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task" }
      const session = {
        metadata,
        permission: Permission.fromConfig({ task: "allow", edit: "deny" }),
      } as unknown as Session.Info
      const rows = [
        { info: { id: userID, role: "user" }, parts: [{ type: "text", text: request }] },
      ] as unknown as SessionV1.WithParts[]
      const agents = {
        get: () =>
          Effect.succeed({ permission: Permission.fromConfig({ task: "allow", edit: "allow" }) } as Agent.Info),
        list: () =>
          Effect.succeed([
            { name: "researcher", mode: "subagent" },
            { name: "designer", mode: "subagent" },
          ] as Agent.Info[]),
      } as Pick<Agent.Interface, "get" | "list">
      const sessions = {
        get: () => Effect.succeed(session),
        messages: () => Effect.succeed(rows),
      } as Pick<Session.Interface, "get" | "messages">
      const goals = {
        get: () => Effect.succeed(state),
      } as Pick<ReturnType<typeof RayaGoal.make>, "get">
      const output = {
        output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface
      const tool = yield* chiefPlanTool({ storage, sessions, agents, goals }).pipe(
        Effect.provideService(Agent.Service, agents as Agent.Interface),
        Effect.provideService(Truncate.Service, output),
      )
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
      const saved = yield* def.execute({ proposals }, ctx)
      expect(saved.metadata.requestID).toBe(userID)
      expect((yield* ChiefBranches.make(storage).read(id))?.branches.map((item) => item.state)).toEqual([
        "planned",
        "planned",
      ])
      expect(yield* def.execute({ proposals }, ctx)).toEqual(saved)

      const edited = [{ ...proposals[0]!, access: "edit" as const }, proposals[1]!]
      expect(Exit.isFailure(yield* def.execute({ proposals: edited }, ctx).pipe(Effect.exit))).toBe(true)
      expect((yield* ChiefBranches.make(storage).read(id))?.branches[0]?.access).toBe("read")
      session.permission = Permission.fromConfig({ task: { "*": "allow", researcher: "deny" } })
      expect(Exit.isFailure(yield* def.execute({ proposals }, ctx).pipe(Effect.exit))).toBe(true)
      session.permission = Permission.fromConfig({ task: "allow", edit: "deny" })
      metadata[RayaChief.requestKey] = "Different request"
      expect(Exit.isFailure(yield* def.execute({ proposals }, ctx).pipe(Effect.exit))).toBe(true)
      expect((yield* ChiefBranches.make(storage).read(id))?.requestID).toBe(userID)
      metadata[RayaChief.requestKey] = request
      rows.push({
        info: { id: MessageID.make(`msg_${crypto.randomUUID()}`), role: "user" },
        parts: [],
      } as unknown as SessionV1.WithParts)
      expect(Exit.isFailure(yield* def.execute({ proposals }, ctx).pipe(Effect.exit))).toBe(true)
    }),
  )
})
