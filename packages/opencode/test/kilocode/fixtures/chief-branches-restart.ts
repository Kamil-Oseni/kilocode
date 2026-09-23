import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit } from "effect"
import { Git } from "../../../src/git"
import { ChiefBranches } from "../../../src/kilocode/chief/branches"
import { SessionID } from "../../../src/session/schema"
import { Storage } from "../../../src/storage/storage"

const [mode, dir, goal, time, session] = process.argv.slice(2)
if (!mode || !dir || !goal || !time || !session) throw new Error("Expected mode, storage directory and branch IDs")

const id = SessionID.make(goal)
const child = SessionID.make(session)
const createdAt = Number(time)
const layer = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))
const plan = [
  {
    id: "audit",
    name: "Safety audit",
    specialist: "researcher",
    access: "read" as const,
    brief: { objective: "Audit safety", constraints: ["Do not edit"], expectedReturn: "Findings" },
  },
  {
    id: "design",
    name: "UX audit",
    specialist: "designer",
    access: "read" as const,
    brief: { objective: "Audit UX", constraints: ["Do not edit"], expectedReturn: "Findings" },
  },
]
const input = {
  goalID: id,
  goalCreatedAt: createdAt,
  branchID: "audit",
  callID: "task-1",
  sessionID: child,
  access: "read" as const,
}

const run = Effect.gen(function* () {
  const storage = yield* Storage.Service
  const ledger = ChiefBranches.make(storage)
  if (mode === "admit") {
    yield* storage.replace(["raya", "goal", id], { createdAt, status: "active" })
    yield* ledger.start({ goalID: id, goalCreatedAt: createdAt, requestID: "route-1", branches: plan })
    const admitted = yield* ledger.admit(input)
    const saved = yield* ledger.read(id)
    process.stdout.write(`CHIEF_SAVED ${JSON.stringify({ pid: process.pid, admitted, saved })}\nREADY\n`)
    yield* Effect.promise(() => new Promise<void>(() => {}))
    return
  }
  if (mode !== "reconcile") throw new Error(`Unknown mode: ${mode}`)
  const before = yield* ledger.read(id)
  const recovered = yield* ledger.reconcile(id, createdAt)
  const again = yield* ledger.reconcile(id, createdAt)
  const replay = yield* ledger.admit(input).pipe(Effect.exit)
  process.stdout.write(
    `CHIEF_RECOVERED ${JSON.stringify({ before, recovered, again, replay: Exit.isFailure(replay) })}\n`,
  )
})

await Effect.runPromise(run.pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.provide(layer)))
