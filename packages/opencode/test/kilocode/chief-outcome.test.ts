import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefBranchOutcome } from "@/kilocode/chief/outcome"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))
const plan = [
  {
    id: "audit",
    name: "Safety audit",
    specialist: "researcher",
    access: "read" as const,
    brief: { objective: "Audit safety", constraints: [], expectedReturn: "Findings" },
  },
  {
    id: "design",
    name: "UX audit",
    specialist: "designer",
    access: "read" as const,
    brief: { objective: "Audit UX", constraints: [], expectedReturn: "Findings" },
  },
]

describe("Auto Chief child outcome", () => {
  it.live("saves terminal results without promoting a failure, interruption, or defect to success", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const cases = [
        { exit: Exit.succeed("private child report"), expected: "completed" },
        { exit: Effect.runSyncExit(Effect.fail(new Error("private failure"))), expected: "failed" },
        { exit: Effect.runSyncExit(Effect.die(new Error("private defect"))), expected: "unknown" },
        { exit: Effect.runSyncExit(Effect.interrupt), expected: "cancelled" },
      ] as const
      for (const [index, item] of cases.entries()) {
        const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const createdAt = Date.now()
        yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
        yield* Effect.addFinalizer(() =>
          Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
            Effect.ignore,
          ),
        )
        const branches = ChiefBranches.make(storage)
        yield* branches.start({ goalID: id, goalCreatedAt: createdAt, requestID: `request-${index}`, branches: plan })
        yield* branches.admit({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "audit",
          callID: `call-${index}`,
          sessionID: child,
          access: "read",
        })
        yield* ChiefBranchOutcome.record({
          branches,
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "audit",
          callID: `call-${index}`,
          sessionID: child,
          exit: item.exit,
        })
        const saved = (yield* branches.read(id))?.branches[0]
        expect(saved?.state).toBe(item.expected)
        expect(saved?.result).not.toContain("private")
        expect(saved?.review).toBeUndefined()
      }
    }),
  )
})
