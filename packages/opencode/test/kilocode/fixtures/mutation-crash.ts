import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import {
  finalizeTransaction,
  prepareTransaction,
  publishTransaction,
  restoreTransaction,
  type TransactionEntry,
} from "@kilocode/sandbox"
import { Git } from "../../../src/git"
import { recover, recoverPending } from "../../../src/kilocode/tool/apply-patch-transaction"
import { journals } from "../../../src/kilocode/tool/mutation-journal"
import { Storage } from "../../../src/storage/storage"

const [mode, dir, root, decision] = process.argv.slice(2)
if (!mode || !dir || !root) throw new Error("Expected mode, storage directory and workspace")
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const id = mode.startsWith("claim")
  ? "killed-claims"
  : mode.startsWith("index")
    ? "killed-index"
    : mode.startsWith("release")
      ? "killed-release"
      : mode.startsWith("matrix")
        ? `killed-${decision?.replace(/[^a-z0-9-]/gi, "-")}`
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
  if (mode === "index-crash") {
    const calls = { value: 0 }
    const stalled = {
      ...storage,
      create: (key: string[], content: unknown) => {
        calls.value++
        if (calls.value !== 2) return storage.create(key, content)
        return Effect.gen(function* () {
          process.stdout.write("READY\n")
          return yield* Effect.never
        })
      },
    }
    yield* journals(stalled).admit({
      invocation: id,
      digest: hash(id),
      workspace: root,
      entries: [entries()[0]],
    })
    return
  }
  if (mode === "claim-crash") {
    const calls = { value: 0 }
    const stalled = {
      ...storage,
      create: (key: string[], content: unknown) => {
        calls.value++
        if (calls.value !== 4) return storage.create(key, content)
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
  if (mode === "matrix-recovery-crash") {
    const calls = { value: 0 }
    const stalled = {
      ...storage,
      create: (key: string[], content: unknown) => {
        calls.value++
        if (calls.value !== 4) return storage.create(key, content)
        return Effect.gen(function* () {
          process.stdout.write("READY\n")
          return yield* Effect.never
        })
      },
    }
    yield* recover(stalled, id)
    return
  }
  if (mode === "matrix-startup") {
    yield* recoverPending(storage)
    const outcome = yield* journals(storage).get(id)
    process.stdout.write(`${JSON.stringify(outcome)}\n`)
    return
  }
  if (mode === "matrix-recover") {
    const outcome = yield* recover(storage, id)
    process.stdout.write(`${JSON.stringify(outcome)}\n`)
    return
  }
  if (mode === "matrix-crash") {
    const [kind, choice, checkpoint] = decision?.split(":") ?? []
    if (!kind || !["create", "remove", "mixed"].includes(kind) || !["commit", "rollback"].includes(choice ?? ""))
      throw new Error("Matrix fixture kind or decision is invalid")
    const pause = (name: string) => {
      if (checkpoint !== name) return Effect.void
      return Effect.gen(function* () {
        process.stdout.write("READY\n")
        return yield* Effect.never
      })
    }
    const anchor = yield* Effect.promise(() => stat(root, { bigint: true }))
    const target = path.join(root, kind === "create" ? "created.txt" : "removed.txt")
    const prior = kind === "remove" ? yield* Effect.promise(() => stat(target, { bigint: true })) : undefined
    const before = prior ? yield* Effect.promise(() => readFile(target)) : undefined
    const source = path.join(root, "source.txt")
    const sourceInfo = kind === "mixed" ? yield* Effect.promise(() => stat(source, { bigint: true })) : undefined
    const sourceData = kind === "mixed" ? yield* Effect.promise(() => readFile(source)) : undefined
    const plan: { entry: TransactionEntry; data?: Uint8Array }[] =
      kind === "mixed"
        ? [
            {
              entry: {
                kind: "create",
                target: path.join(root, "moved.txt"),
                stage: path.join(root, `.raya-txn-${id}-destination.stage`),
                anchor: {
                  path: root,
                  identity: { dev: anchor.dev.toString(), ino: anchor.ino.toString() },
                },
                result: { sha256: hash("source before") },
              },
              data: sourceData,
            },
            {
              entry: {
                kind: "remove",
                target: source,
                hold: path.join(root, `.raya-txn-${id}-source.hold`),
                review: {
                  identity: { dev: sourceInfo!.dev.toString(), ino: sourceInfo!.ino.toString() },
                  sha256: hash("source before"),
                },
              },
            },
          ]
        : [
            {
              entry:
                kind === "create"
                  ? {
                      kind: "create",
                      target,
                      stage: path.join(root, `.raya-txn-${id}.stage`),
                      anchor: {
                        path: root,
                        identity: { dev: anchor.dev.toString(), ino: anchor.ino.toString() },
                      },
                      result: { sha256: hash("created") },
                    }
                  : {
                      kind: "remove",
                      target,
                      hold: path.join(root, `.raya-txn-${id}.hold`),
                      review: {
                        identity: { dev: prior!.dev.toString(), ino: prior!.ino.toString() },
                        sha256: createHash("sha256").update(before!).digest("hex"),
                      },
                    },
              data: kind === "create" ? Buffer.from("created") : undefined,
            },
          ]
    const journal = journals(storage)
    const admitted = yield* journal.admit({
      invocation: id,
      digest: hash(id),
      workspace: root,
      entries: plan.map((item) => item.entry),
    })
    if (!admitted.owned) throw new Error("Matrix fixture did not own its journal")
    const staged = [...admitted.outcome.entries]
    let outcome = admitted.outcome
    yield* pause("staging-0")
    for (const [index, item] of plan.entries()) {
      if (item.entry.kind !== "remove") {
        if (!item.data) throw new Error("Matrix fixture data is missing")
        const artifact = yield* prepareTransaction(staged[index], item.data)
        staged[index] = { ...staged[index], artifact }
      }
      yield* pause(`stage-${index + 1}`)
      outcome = yield* journal.advance(id, {
        token: admitted.token,
        revision: outcome.revision,
        phase: "staging",
        cursor: index + 1,
        entries: staged,
      })
      yield* pause(`staging-${index + 1}`)
    }
    const prepared = yield* journal.advance(id, {
      token: admitted.token,
      revision: outcome.revision,
      phase: "prepared",
      cursor: staged.length,
      entries: staged,
    })
    yield* pause("prepared")
    const committing = yield* journal.advance(id, {
      token: admitted.token,
      revision: prepared.revision,
      phase: "committing",
      cursor: 0,
      entries: staged,
    })
    yield* pause("committing-0")
    let published = committing
    for (const [index, entry] of staged.entries()) {
      yield* publishTransaction(entry)
      yield* pause(`publish-${index + 1}`)
      published = yield* journal.advance(id, {
        token: admitted.token,
        revision: published.revision,
        phase: "committing",
        cursor: index + 1,
        entries: staged,
      })
      yield* pause(`committing-${index + 1}`)
    }
    if (choice === "commit") {
      const committed = yield* journal.advance(id, {
        token: admitted.token,
        revision: published.revision,
        phase: "committed",
        cursor: staged.length,
        entries: staged,
      })
      yield* pause("committed")
      if (checkpoint?.startsWith("commit-")) {
        let cleaning = yield* journal.advance(id, {
          token: admitted.token,
          revision: committed.revision,
          phase: "cleaning",
          cursor: 0,
          entries: staged,
        })
        yield* pause("commit-cleaning-0")
        for (const [index, entry] of staged.entries()) {
          yield* finalizeTransaction(entry, true)
          yield* pause(`commit-cleanup-${index + 1}`)
          cleaning = yield* journal.advance(id, {
            token: admitted.token,
            revision: cleaning.revision,
            phase: "cleaning",
            cursor: index + 1,
            entries: staged,
          })
          yield* pause(`commit-cleaning-${index + 1}`)
        }
        yield* journal.advance(id, {
          token: admitted.token,
          revision: cleaning.revision,
          phase: "releasing",
          cursor: staged.length,
          entries: staged,
        })
        yield* pause("commit-releasing")
      }
    }
    if (choice === "rollback" && checkpoint?.startsWith("rollback-")) {
      let rolling = yield* journal.advance(id, {
        token: admitted.token,
        revision: published.revision,
        phase: "rolling_back",
        cursor: 0,
        entries: staged,
      })
      yield* pause("rollback-rolling-0")
      for (const [index, entry] of staged.toReversed().entries()) {
        yield* restoreTransaction(entry)
        yield* pause(`rollback-restore-${index + 1}`)
        rolling = yield* journal.advance(id, {
          token: admitted.token,
          revision: rolling.revision,
          phase: "rolling_back",
          cursor: index + 1,
          entries: staged,
        })
        yield* pause(`rollback-rolling-${index + 1}`)
      }
      const rolled = yield* journal.advance(id, {
        token: admitted.token,
        revision: rolling.revision,
        phase: "rolled_back",
        cursor: staged.length,
        entries: staged,
      })
      yield* pause("rollback-rolled")
      let cleaning = yield* journal.advance(id, {
        token: admitted.token,
        revision: rolled.revision,
        phase: "cleaning",
        cursor: 0,
        entries: staged,
      })
      yield* pause("rollback-cleaning-0")
      for (const [index, entry] of staged.entries()) {
        yield* finalizeTransaction(entry, false)
        yield* pause(`rollback-cleanup-${index + 1}`)
        cleaning = yield* journal.advance(id, {
          token: admitted.token,
          revision: cleaning.revision,
          phase: "cleaning",
          cursor: index + 1,
          entries: staged,
        })
        yield* pause(`rollback-cleaning-${index + 1}`)
      }
      yield* journal.advance(id, {
        token: admitted.token,
        revision: cleaning.revision,
        phase: "releasing",
        cursor: staged.length,
        entries: staged,
      })
      yield* pause("rollback-releasing")
    }
    if (checkpoint) throw new Error(`Matrix checkpoint was not reached: ${checkpoint}`)
    process.stdout.write("READY\n")
    return yield* Effect.never
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
