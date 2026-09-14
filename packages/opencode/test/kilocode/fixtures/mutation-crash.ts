import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { prepareTransaction, publishTransaction, type TransactionEntry } from "@kilocode/sandbox"
import { Git } from "../../../src/git"
import { recover } from "../../../src/kilocode/tool/apply-patch-transaction"
import { journals } from "../../../src/kilocode/tool/mutation-journal"
import { Storage } from "../../../src/storage/storage"

const [mode, dir, root, decision] = process.argv.slice(2)
if (!mode || !dir || !root) throw new Error("Expected mode, storage directory and workspace")
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const id = `killed-${decision === "commit"}`
const layer = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))

const run = Effect.gen(function* () {
  const storage = yield* Storage.Service
  if (mode === "recover") {
    const outcome = yield* recover(storage, id)
    process.stdout.write(`${JSON.stringify(outcome)}\n`)
    return
  }
  const target = path.join(root, "killed.txt")
  const info = yield* Effect.promise(() => stat(target, { bigint: true }))
  const entry: TransactionEntry = {
    kind: "replace",
    target,
    stage: path.join(root, `.raya-txn-${id}.stage`),
    hold: path.join(root, `.raya-txn-${id}.hold`),
    review: {
      identity: { dev: info.dev.toString(), ino: info.ino.toString() },
      sha256: hash("before"),
    },
    result: { sha256: hash("after") },
  }
  const journal = journals(storage)
  const admitted = yield* journal.admit({ invocation: id, digest: hash(id), workspace: root, entries: [entry] })
  if (!admitted.owned) throw new Error("Crash fixture did not own its journal")
  const artifact = yield* prepareTransaction(entry, Buffer.from("after"))
  const staged = { ...entry, artifact }
  const staging = yield* journal.advance(id, {
    token: admitted.token,
    revision: admitted.outcome.revision,
    phase: "staging",
    cursor: 1,
    entries: [staged],
  })
  const prepared = yield* journal.advance(id, {
    token: admitted.token,
    revision: staging.revision,
    phase: "prepared",
    cursor: 1,
    entries: [staged],
  })
  const committing = yield* journal.advance(id, {
    token: admitted.token,
    revision: prepared.revision,
    phase: "committing",
    cursor: 0,
    entries: [staged],
  })
  yield* publishTransaction(staged)
  const published = yield* journal.advance(id, {
    token: admitted.token,
    revision: committing.revision,
    phase: "committing",
    cursor: 1,
    entries: [staged],
  })
  if (decision === "commit")
    yield* journal.advance(id, {
      token: admitted.token,
      revision: published.revision,
      phase: "committed",
      cursor: 1,
      entries: [staged],
    })
  process.stdout.write("READY\n")
  yield* Effect.promise(() => new Promise<void>(() => {}))
})

await Effect.runPromise(run.pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.provide(layer)))
