import { createHash } from "node:crypto"
import { link, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
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
const cli = fileURLToPath(new URL("../../src/index.ts", import.meta.url))

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

async function kill(mode: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, fixture, mode, ...args], {
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
        timer.id = setTimeout(() => reject(new Error(`${mode} did not reach its checkpoint`)), 20_000)
      }),
    ])
  } finally {
    if (timer.id) clearTimeout(timer.id)
    proc.kill("SIGKILL")
    await proc.exited
  }
}

async function child(mode: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, fixture, mode, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolate(args[1]),
  })
  const [output, failure, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(failure)
  return Schema.decodeUnknownSync(Outcome)(JSON.parse(output.trim()))
}

async function attempt(mode: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, fixture, mode, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolate(args[1]),
  })
  const [output, failure, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output, failure, code }
}

async function boot(root: string) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", cli, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.dirname(path.dirname(cli)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...isolate(root),
      KILO_DISABLE_DEFAULT_PLUGINS: "true",
      KILO_TELEMETRY_LEVEL: "off",
    },
  })
  const reader = proc.stdout.getReader()
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const listening = async () => {
    let output = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(await new Response(proc.stderr).text())
      output += new TextDecoder().decode(chunk.value)
      const match = output.match(/kilo server listening on (http:\/\/[^\s]+)/)
      if (match) return match[1]
    }
  }
  try {
    const url = await Promise.race([
      listening(),
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(() => reject(new Error("Development backend did not start")), 30_000)
      }),
    ])
    const response = await fetch(`${url}/config?directory=${encodeURIComponent(root)}`)
    if (!response.ok) throw new Error(`Development backend returned ${response.status}: ${await response.text()}`)
  } finally {
    if (timer.id) clearTimeout(timer.id)
    proc.kill("SIGKILL")
    await proc.exited
  }
}

const transaction = (spec: string) => `killed-${spec.replace(/[^a-z0-9-]/gi, "-")}`

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
        yield* Effect.promise(() => kill("crash", [dir, root, committed ? "commit" : "rollback"]))
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

for (const kind of ["create", "remove", "mixed"] as const)
  for (const committed of [false, true])
    it.live(
      `recovers a killed ${kind} transaction ${committed ? "after" : "before"} commit`,
      () =>
        Effect.gen(function* () {
          const root = yield* tmpdirScoped()
          const dir = path.join(root, "storage")
          const created = path.join(root, "created.txt")
          const removed = path.join(root, "removed.txt")
          const source = path.join(root, "source.txt")
          const moved = path.join(root, "moved.txt")
          if (kind === "remove") yield* Effect.promise(() => writeFile(removed, "removed before"))
          if (kind === "mixed") yield* Effect.promise(() => writeFile(source, "source before"))
          const decision = committed ? "commit" : "rollback"
          yield* Effect.promise(() => kill("matrix-crash", [dir, root, `${kind}:${decision}`]))
          if (kind === "create") expect(yield* Effect.promise(() => readFile(created, "utf8"))).toBe("created")
          if (kind === "remove") expect(yield* Effect.promise(() => Bun.file(removed).exists())).toBe(false)
          if (kind === "mixed") {
            expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("source before")
            expect(yield* Effect.promise(() => Bun.file(source).exists())).toBe(false)
          }
          const outcome = yield* Effect.promise(() => child("matrix-recover", [dir, root, `${kind}:${decision}`]))
          expect(outcome.phase).toBe("done")
          expect(outcome.decision).toBe(committed ? "commit" : "rollback")
          if (kind === "create") {
            expect(yield* Effect.promise(() => Bun.file(created).exists())).toBe(committed)
            if (committed) expect(yield* Effect.promise(() => readFile(created, "utf8"))).toBe("created")
          }
          if (kind === "remove") {
            expect(yield* Effect.promise(() => Bun.file(removed).exists())).toBe(!committed)
            if (!committed) expect(yield* Effect.promise(() => readFile(removed, "utf8"))).toBe("removed before")
          }
          if (kind === "mixed") {
            expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(committed)
            expect(yield* Effect.promise(() => Bun.file(source).exists())).toBe(!committed)
            const target = committed ? moved : source
            expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("source before")
          }
          expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
        }),
      30_000,
    )

for (const checkpoint of [
  "staging-0",
  "stage-1",
  "staging-1",
  "stage-2",
  "staging-2",
  "prepared",
  "committing-0",
  "publish-1",
  "committing-1",
  "publish-2",
  "committing-2",
] as const)
  it.live(
    `rolls a killed mixed transaction back from ${checkpoint}`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const dir = path.join(root, "storage")
        const source = path.join(root, "source.txt")
        const moved = path.join(root, "moved.txt")
        yield* Effect.promise(() => writeFile(source, "source before"))
        yield* Effect.promise(() => kill("matrix-crash", [dir, root, `mixed:rollback:${checkpoint}`]))
        const outcome = yield* Effect.promise(() =>
          child("matrix-recover", [dir, root, `mixed:rollback:${checkpoint}`]),
        )
        expect(outcome.phase).toBe("done")
        expect(outcome.decision).toBe("rollback")
        expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
        expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
        expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
      }),
    30_000,
  )

for (const [decision, checkpoint] of [
  ["rollback", "rollback-rolling-0"],
  ["rollback", "rollback-restore-1"],
  ["rollback", "rollback-rolling-1"],
  ["rollback", "rollback-restore-2"],
  ["rollback", "rollback-rolling-2"],
  ["rollback", "rollback-rolled"],
  ["rollback", "rollback-cleaning-0"],
  ["rollback", "rollback-cleanup-1"],
  ["rollback", "rollback-cleaning-1"],
  ["rollback", "rollback-cleanup-2"],
  ["rollback", "rollback-cleaning-2"],
  ["rollback", "rollback-releasing"],
  ["commit", "commit-cleaning-0"],
  ["commit", "commit-cleanup-1"],
  ["commit", "commit-cleaning-1"],
  ["commit", "commit-cleanup-2"],
  ["commit", "commit-cleaning-2"],
  ["commit", "commit-releasing"],
] as const)
  it.live(
    `recovers a killed mixed ${decision} from ${checkpoint}`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const dir = path.join(root, "storage")
        const source = path.join(root, "source.txt")
        const moved = path.join(root, "moved.txt")
        yield* Effect.promise(() => writeFile(source, "source before"))
        yield* Effect.promise(() => kill("matrix-crash", [dir, root, `mixed:${decision}:${checkpoint}`]))
        const outcome = yield* Effect.promise(() =>
          child("matrix-recover", [dir, root, `mixed:${decision}:${checkpoint}`]),
        )
        expect(outcome.phase).toBe("done")
        expect(outcome.decision).toBe(decision)
        expect(yield* Effect.promise(() => Bun.file(source).exists())).toBe(decision === "rollback")
        expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(decision === "commit")
        const target = decision === "commit" ? moved : source
        expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("source before")
        expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
      }),
    30_000,
  )

for (const scenario of [
  "changed-destination",
  "recreated-source",
  "changed-commit",
  "replaced-stage",
  "replaced-hold",
] as const)
  it.live(
    `retains a recovery conflict for ${scenario}`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const dir = path.join(root, "storage")
        const source = path.join(root, "source.txt")
        const moved = path.join(root, "moved.txt")
        yield* Effect.promise(() => writeFile(source, "source before"))
        const spec =
          scenario === "changed-commit"
            ? "mixed:commit:committed"
            : scenario === "replaced-stage"
              ? "mixed:rollback:staging-1"
              : "mixed:rollback:publish-2"
        const id = transaction(spec)
        const stage = path.join(root, `.raya-txn-${id}-destination.stage`)
        const hold = path.join(root, `.raya-txn-${id}-source.hold`)
        yield* Effect.promise(() => kill("matrix-crash", [dir, root, spec]))
        if (scenario === "recreated-source") yield* Effect.promise(() => writeFile(source, "user recreated"))
        if (scenario === "changed-destination" || scenario === "changed-commit")
          yield* Effect.promise(() => writeFile(moved, "user destination"))
        if (scenario === "replaced-stage")
          yield* Effect.promise(async () => {
            await unlink(stage)
            await writeFile(stage, "foreign stage")
          })
        if (scenario === "replaced-hold")
          yield* Effect.promise(async () => {
            await unlink(hold)
            await writeFile(hold, "foreign hold")
          })
        const result = yield* Effect.promise(() => attempt("matrix-recover", [dir, root, spec]))
        expect(result.code).not.toBe(0)
        const outcome = yield* instance(dir, (storage) => journals(storage).get(transaction(spec)))
        expect(outcome?.phase).toBe("conflict")
        if (scenario === "recreated-source") {
          expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("user recreated")
          expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("source before")
        }
        if (scenario === "changed-destination" || scenario === "changed-commit") {
          expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("user destination")
        }
        if (scenario === "replaced-stage") {
          expect(yield* Effect.promise(() => readFile(stage, "utf8"))).toBe("foreign stage")
          expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
          expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
        }
        if (scenario === "replaced-hold") {
          expect(yield* Effect.promise(() => readFile(hold, "utf8"))).toBe("foreign hold")
          expect(yield* Effect.promise(() => Bun.file(source).exists())).toBe(false)
          expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("source before")
        }
        expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(true)
      }),
    30_000,
  )

it.live(
  "restores newer bytes written through a displaced preimage after process death",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const source = path.join(root, "source.txt")
      const moved = path.join(root, "moved.txt")
      const spec = "mixed:rollback:publish-2"
      const hold = path.join(root, `.raya-txn-${transaction(spec)}-source.hold`)
      yield* Effect.promise(() => writeFile(source, "source before"))
      yield* Effect.promise(() => kill("matrix-crash", [dir, root, spec]))
      yield* Effect.promise(() => writeFile(hold, "user newer"))
      const outcome = yield* Effect.promise(() => child("matrix-recover", [dir, root, spec]))
      expect(outcome.phase).toBe("done")
      expect(outcome.decision).toBe("rollback")
      expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("user newer")
      expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
      expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
    }),
  30_000,
)

it.live(
  "recovers after the recovery process is killed between restore and cursor publication",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const source = path.join(root, "source.txt")
      const moved = path.join(root, "moved.txt")
      const spec = "mixed:rollback:publish-2"
      yield* Effect.promise(() => writeFile(source, "source before"))
      yield* Effect.promise(() => kill("matrix-crash", [dir, root, spec]))
      yield* Effect.promise(() => kill("matrix-recovery-crash", [dir, root, spec]))
      expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
      expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("source before")
      const outcome = yield* Effect.promise(() => child("matrix-recover", [dir, root, spec]))
      expect(outcome.phase).toBe("done")
      expect(outcome.decision).toBe("rollback")
      expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
      expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
      expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
      const repeated = yield* Effect.promise(() => child("matrix-recover", [dir, root, spec]))
      expect(repeated.phase).toBe("done")
      expect(repeated.decision).toBe("rollback")
      expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
    }),
  30_000,
)

it.live(
  "discovers and recovers a killed transaction through the bounded startup index",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const source = path.join(root, "source.txt")
      const moved = path.join(root, "moved.txt")
      const spec = "mixed:rollback:publish-2"
      yield* Effect.promise(() => writeFile(source, "source before"))
      yield* Effect.promise(() => kill("matrix-crash", [dir, root, spec]))
      const outcome = yield* Effect.promise(() => child("matrix-startup", [dir, root, spec]))
      expect(outcome.phase).toBe("done")
      expect(outcome.decision).toBe("rollback")
      expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
      expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
      expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
      expect((yield* instance(dir, (storage) => journals(storage).pending())).outcomes).toHaveLength(0)
    }),
  30_000,
)

it.live(
  "recovers a killed transaction when a fresh development backend loads the workspace",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "xdg-data", "kilo", "storage")
      const source = path.join(root, "source.txt")
      const moved = path.join(root, "moved.txt")
      const spec = "mixed:rollback:publish-2"
      yield* Effect.promise(() => writeFile(source, "source before"))
      yield* Effect.promise(() => kill("matrix-crash", [dir, root, spec]))
      expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("source before")

      yield* Effect.promise(() => boot(root))

      const outcome = yield* instance(dir, (storage) => journals(storage).get(transaction(spec)))
      expect(outcome?.phase).toBe("done")
      expect(outcome?.decision).toBe("rollback")
      expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("source before")
      expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
      expect((yield* Effect.promise(() => readdir(root))).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
      expect((yield* instance(dir, (storage) => journals(storage).pending())).outcomes).toHaveLength(0)
    }),
  45_000,
)
