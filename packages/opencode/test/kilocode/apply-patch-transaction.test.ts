import { createHash } from "node:crypto"
import { link, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Schema } from "effect"
import { prepareTransaction, publishTransaction, restoreTransaction } from "@kilocode/sandbox"
import { Git } from "@/git"
import { recover, transact, type Item } from "@/kilocode/tool/apply-patch-transaction"
import { journals, Outcome } from "@/kilocode/tool/mutation-journal"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const fixture = fileURLToPath(new URL("./fixtures/mutation-crash.ts", import.meta.url))

function isolate(root: string) {
  return {
    ...process.env,
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    KILO_TEST_HOME: path.join(root, "home"),
    KILO_DB: ":memory:",
    KILO_DISABLE_MODELS_FETCH: "true",
  }
}

async function crash(args: string[]) {
  const proc = Bun.spawn([process.execPath, fixture, "crash", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolate(args[1]),
  })
  const reader = proc.stdout.getReader()
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const ready = async () => {
    let text = ""
    while (!text.includes("READY")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(await new Response(proc.stderr).text())
      text += new TextDecoder().decode(chunk.value)
    }
  }
  try {
    await Promise.race([
      ready(),
      new Promise((_, reject) => {
        timer.id = setTimeout(() => reject(new Error("Crash fixture did not reach its checkpoint")), 20_000)
      }),
    ])
  } finally {
    if (timer.id) clearTimeout(timer.id)
    proc.kill("SIGKILL")
    await proc.exited
  }
}

function instance<A, E>(dir: string, run: (storage: Storage.Interface) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    return yield* run(yield* Storage.Service)
  }).pipe(Effect.provide(Storage.layerFromDir(dir)))
}

it.live("commits all postimages before cleanup and retains an idempotent receipt", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const target = path.join(root, "existing.txt")
    const created = path.join(root, "created.txt")
    yield* Effect.promise(() => writeFile(target, "before"))
    const prior = yield* Effect.promise(() => stat(target, { bigint: true }))
    const anchor = yield* Effect.promise(() => stat(root, { bigint: true }))
    const items: Item[] = [
      {
        entry: {
          kind: "replace",
          target,
          stage: path.join(root, ".raya-txn-complete-0.stage"),
          hold: path.join(root, ".raya-txn-complete-0.hold"),
          review: {
            identity: { dev: prior.dev.toString(), ino: prior.ino.toString() },
            sha256: hash("before"),
          },
          result: { sha256: hash("after") },
        },
        data: Buffer.from("after"),
      },
      {
        entry: {
          kind: "create",
          target: created,
          stage: path.join(root, ".raya-txn-complete-1.stage"),
          anchor: { path: root, identity: { dev: anchor.dev.toString(), ino: anchor.ino.toString() } },
          result: { sha256: hash("created") },
        },
        data: Buffer.from("created"),
      },
    ]
    const input = { invocation: "complete", digest: hash("complete patch"), workspace: root, items }
    const outcome = yield* instance(dir, (storage) => transact(storage, input))
    expect(outcome.phase).toBe("done")
    expect(outcome.decision).toBe("commit")
    expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("after")
    expect(yield* Effect.promise(() => readFile(created, "utf8"))).toBe("created")
    expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
    expect((yield* instance(dir, (storage) => journals(storage).get(input.invocation)))?.phase).toBe("done")
    expect(Exit.isFailure(yield* instance(dir, (storage) => transact(storage, input).pipe(Effect.exit)))).toBe(true)
    expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("after")
  }),
)

it.live("rolls back earlier files when a later checked mutation fails", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const first = path.join(root, "first.txt")
    const second = path.join(root, "second.txt")
    const alias = path.join(root, "alias.txt")
    yield* Effect.promise(() => Promise.all([writeFile(first, "first before"), writeFile(second, "second before")]))
    const firstInfo = yield* Effect.promise(() => stat(first, { bigint: true }))
    const secondInfo = yield* Effect.promise(() => stat(second, { bigint: true }))
    const items: Item[] = [
      {
        entry: {
          kind: "replace",
          target: first,
          stage: path.join(root, ".raya-txn-rollback-0.stage"),
          hold: path.join(root, ".raya-txn-rollback-0.hold"),
          review: {
            identity: { dev: firstInfo.dev.toString(), ino: firstInfo.ino.toString() },
            sha256: hash("first before"),
          },
          result: { sha256: hash("first after") },
        },
        data: Buffer.from("first after"),
      },
      {
        entry: {
          kind: "remove",
          target: second,
          hold: path.join(root, ".raya-txn-rollback-1.hold"),
          review: {
            identity: { dev: secondInfo.dev.toString(), ino: secondInfo.ino.toString() },
            sha256: hash("second before"),
          },
        },
      },
    ]
    yield* Effect.promise(() => link(second, alias))
    const input = { invocation: "rollback", digest: hash("rollback patch"), workspace: root, items }
    expect(Exit.isFailure(yield* instance(dir, (storage) => transact(storage, input).pipe(Effect.exit)))).toBe(true)
    expect(yield* Effect.promise(() => readFile(first, "utf8"))).toBe("first before")
    expect(yield* Effect.promise(() => readFile(second, "utf8"))).toBe("second before")
    expect(yield* Effect.promise(() => readFile(alias, "utf8"))).toBe("second before")
    expect((yield* instance(dir, (storage) => journals(storage).get(input.invocation)))?.decision).toBe("rollback")
    expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
  }),
)

for (const checkpoint of ["precommit", "committed", "rollback-cleaning"] as const)
  it.live(`recovers a replacement from ${checkpoint}`, () =>
    Effect.gen(function* () {
      const committed = checkpoint === "committed"
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const target = path.join(root, "recover.txt")
      yield* Effect.promise(() => writeFile(target, "before"))
      const info = yield* Effect.promise(() => stat(target, { bigint: true }))
      const entry: Item["entry"] = {
        kind: "replace",
        target,
        stage: path.join(root, `.raya-txn-recover-${checkpoint}.stage`),
        hold: path.join(root, `.raya-txn-recover-${checkpoint}.hold`),
        review: {
          identity: { dev: info.dev.toString(), ino: info.ino.toString() },
          sha256: hash("before"),
        },
        result: { sha256: hash("after") },
      }
      const id = `recover-${checkpoint}`
      const admitted = yield* instance(dir, (storage) =>
        journals(storage).admit({ invocation: id, digest: hash(id), workspace: root, entries: [entry] }),
      )
      expect(admitted.owned).toBe(true)
      if (!admitted.owned) return
      const artifact = yield* prepareTransaction(entry, Buffer.from("after"))
      const staged = { ...entry, artifact }
      const journal = (
        revision: number,
        phase: "staging" | "prepared" | "committing" | "committed" | "rolling_back" | "rolled_back" | "cleaning",
        cursor: number,
      ) =>
        instance(dir, (storage) =>
          journals(storage).advance(id, {
            token: admitted.token,
            revision,
            phase,
            cursor,
            entries: [staged],
          }),
        )
      const staging = yield* journal(1, "staging", 1)
      const prepared = yield* journal(staging.revision, "prepared", 1)
      const committing = yield* journal(prepared.revision, "committing", 0)
      yield* publishTransaction(staged)
      const published = yield* journal(committing.revision, "committing", 1)
      if (committed) yield* journal(published.revision, "committed", 1)
      if (checkpoint === "rollback-cleaning") {
        const rolling = yield* journal(published.revision, "rolling_back", 0)
        yield* restoreTransaction(staged)
        const restored = yield* journal(rolling.revision, "rolling_back", 1)
        const rolled = yield* journal(restored.revision, "rolled_back", 1)
        yield* journal(rolled.revision, "cleaning", 0)
      }

      const outcome = yield* instance(dir, (storage) => recover(storage, id, () => Effect.succeed(true)))
      expect(outcome?.phase).toBe("done")
      expect(outcome?.decision).toBe(committed ? "commit" : "rollback")
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(committed ? "after" : "before")
      expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
    }),
  )

for (const committed of [false, true])
  it.live(
    `uses a fresh process to recover a worker killed ${committed ? "after" : "before"} commit`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const dir = path.join(root, "storage")
        const target = path.join(root, "killed.txt")
        yield* Effect.promise(() => writeFile(target, "before"))
        yield* Effect.promise(() => crash([dir, root, committed ? "commit" : "rollback"]))
        expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("after")
        const proc = Bun.spawn([process.execPath, fixture, "recover", dir, root, committed ? "commit" : "rollback"], {
          stdout: "pipe",
          stderr: "pipe",
          env: isolate(root),
        })
        const [output, failure, code] = yield* Effect.promise(() =>
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        )
        expect(code, failure).toBe(0)
        const outcome = Schema.decodeUnknownSync(Outcome)(JSON.parse(output.trim()))
        expect(outcome.phase).toBe("done")
        expect(outcome.decision).toBe(committed ? "commit" : "rollback")
        expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(committed ? "after" : "before")
        expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
      }),
    30_000,
  )
