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
const id = mode.startsWith("claim")
  ? "killed-claims"
  : mode.startsWith("release")
    ? "killed-release"
    : `killed-${decision === "commit"}`
const layer = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))
const proof = { identity: { dev: "1", ino: "2" }, sha256: hash("before") }
const postimage = { identity: { dev: "3", ino: "4" }, sha256: hash("after") }

function entries(): TransactionEntry[] {
  return ["a.txt", "b.txt"].map((name, index) => ({
    kind: "replace",
    target: path.join(root, name),
    stage: path.join(root, `.raya-txn-${id}-${index}.stage`),
    hold: path.join(root, `.raya-txn-${id}-${index}.hold`),
    review: proof,
    result: { sha256: postimage.sha256 },
  }))
}

const run = Effect.gen(function* () {
  const storage = yield* Storage.Service
  if (mode === "claim-crash") {
    const calls = { value: 0 }
    const stalled = {
      ...storage,
      create: (key: string[], content: unknown) => {
        calls.value++
        if (calls.value !== 3) return storage.create(key, content)
        return Effect.gen(function* () {
          process.stdout.write("READY\n")
          return yield* Effect.never
        })
      },
    }
    yield* journals(stalled).admit({ invocation: id, digest: hash(id), workspace: root, entries: entries() })
    return
  }
  if (mode === "claim-recover") {
    const journal = journals(storage)
    const claimed = yield* journal.recover(id)
    if (!claimed.owned) throw new Error("Claim recovery fixture did not own its journal")
    const rolling = yield* journal.advance(id, {
      token: claimed.token,
      revision: claimed.outcome.revision,
      phase: "rolling_back",
      cursor: 0,
    })
    const rolled = yield* journal.advance(id, {
      token: claimed.token,
      revision: rolling.revision,
      phase: "rolled_back",
      cursor: entries().length,
    })
    const cleaning = yield* journal.advance(id, {
      token: claimed.token,
      revision: rolled.revision,
      phase: "cleaning",
      cursor: 0,
    })
    const cleaned = yield* journal.advance(id, {
      token: claimed.token,
      revision: cleaning.revision,
      phase: "cleaning",
      cursor: entries().length,
    })
    const releasing = yield* journal.advance(id, {
      token: claimed.token,
      revision: cleaned.revision,
      phase: "releasing",
      cursor: entries().length,
    })
    const done = yield* journal.advance(id, {
      token: claimed.token,
      revision: releasing.revision,
      phase: "done",
      cursor: entries().length,
    })
    process.stdout.write(`${JSON.stringify(done)}\n`)
    return
  }
  if (mode === "release-crash") {
    const journal = journals(storage)
    const admitted = yield* journal.admit({ invocation: id, digest: hash(id), workspace: root, entries: entries() })
    if (!admitted.owned) throw new Error("Release fixture did not own its journal")
    const staged = entries().map((entry) => ({ ...entry, artifact: postimage }))
    const prepared = yield* journal.advance(id, {
      token: admitted.token,
      revision: admitted.outcome.revision,
      phase: "prepared",
      cursor: staged.length,
      entries: staged,
    })
    const committing = yield* journal.advance(id, {
      token: admitted.token,
      revision: prepared.revision,
      phase: "committing",
      cursor: 0,
      entries: staged,
    })
    const published = yield* journal.advance(id, {
      token: admitted.token,
      revision: committing.revision,
      phase: "committing",
      cursor: staged.length,
      entries: staged,
    })
    const committed = yield* journal.advance(id, {
      token: admitted.token,
      revision: published.revision,
      phase: "committed",
      cursor: staged.length,
      entries: staged,
    })
    const cleaning = yield* journal.advance(id, {
      token: admitted.token,
      revision: committed.revision,
      phase: "cleaning",
      cursor: 0,
      entries: staged,
    })
    const cleaned = yield* journal.advance(id, {
      token: admitted.token,
      revision: cleaning.revision,
      phase: "cleaning",
      cursor: staged.length,
      entries: staged,
    })
    const calls = { value: 0 }
    const stalled = {
      ...storage,
      remove: (key: string[]) => {
        calls.value++
        if (calls.value !== 2) return storage.remove(key)
        return Effect.gen(function* () {
          process.stdout.write("READY\n")
          return yield* Effect.never
        })
      },
    }
    yield* journals(stalled).advance(id, {
      token: admitted.token,
      revision: cleaned.revision,
      phase: "releasing",
      cursor: staged.length,
      entries: staged,
    })
    return
  }
  if (mode === "release-recover") {
    const journal = journals(storage)
    const claimed = yield* journal.recover(id)
    if (!claimed.owned) throw new Error("Release recovery fixture did not own its journal")
    const done = yield* journal.advance(id, {
      token: claimed.token,
      revision: claimed.outcome.revision,
      phase: "done",
      cursor: claimed.outcome.entries.length,
    })
    process.stdout.write(`${JSON.stringify(done)}\n`)
    return
  }
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
