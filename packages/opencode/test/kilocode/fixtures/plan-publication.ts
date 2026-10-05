import assert from "node:assert/strict"
import type { Effect as Fx } from "effect"
import type { FSUtil as Files } from "@opencode-ai/core/fs-util"
import path from "node:path"
import { link, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
const [root, mode] = process.argv.slice(2)
assert(root && mode)
const data = path.join(root, "data")
const plans = path.join(data, "plans")
const file = path.join(plans, "actual.md")
await mkdir(plans, { recursive: true })
Object.assign(process.env, {
  HOME: root,
  USERPROFILE: root,
  KILO_TEST_HOME: root,
  XDG_DATA_HOME: data,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  KILO_DB: ":memory:",
  RAYA_DB: ":memory:",
  KILO_AUTH_CONTENT: "{}",
  RAYA_AUTH_CONTENT: "{}",
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
  KILO_DISABLE_AUTOUPDATE: "1",
})
const { PlanPublication } = await import("../../../src/kilocode/plan-publication")
const io = await import("../../../src/kilocode/tool/encoded-io")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { FSUtil } = await import("@opencode-ai/core/fs-util")
const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
const { closeProcessProfile } = await import("@opencode-ai/core/kilocode/process-profile")
const { coordinateNativeRoots } = await import("@opencode-ai/core/kilocode/profile-maintenance")
const { Hash } = await import("@opencode-ai/core/util/hash")
const { Effect } = await import("effect")
const layer = LayerNode.compile(FSUtil.node)
const run = <A, E>(work: Fx.Effect<A, E, Files.Service>) => Effect.runPromise(work.pipe(Effect.provide(layer)))
const reasons = (err: unknown): string[] =>
  err instanceof AggregateError ? [String(err), ...err.errors.flatMap(reasons)] : [String(err)]
let profile = true
await PlanPublication.using(plans, async () => {
  try {
    if (mode === "files") {
      await run(FSUtil.Service.use((fs) => io.exclusive(fs, file, "# actual\n")))
      const proof = await Effect.runPromise(io.identity(file))
      const before = await run(FSUtil.Service.use((fs) => io.read(fs, file)))
      await Effect.runPromise(io.checked(file, "# edited\n", before.encoding, proof, before.sha256))
      assert.equal(await readFile(file, "utf8"), "# edited\n")
      const final = await run(FSUtil.Service.use((fs) => io.read(fs, file)))
      await Effect.runPromise(io.remove(file, await Effect.runPromise(io.identity(file)), final.sha256))
      await assert.rejects(readFile(file), { code: "ENOENT" })
    } else if (mode === "maintenance") {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const gate = coordinateNativeRoots([{ kind: "json", path: plans }], async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const work = run(FSUtil.Service.use((fs) => io.exclusive(fs, file, "# released\n")))
      const shutdown = KiloShutdown.run()
      let joined = false
      const settled = shutdown.then(() => {
        joined = true
      })
      try {
        await Bun.sleep(75)
        assert.equal(joined, false)
        await assert.rejects(readFile(file), { code: "ENOENT" })
      } finally {
        release.resolve()
      }
      const results = await Promise.allSettled([gate, work, settled])
      for (const result of results) if (result.status === "rejected") throw result.reason
      assert.equal(await readFile(file, "utf8"), "# released\n")
    } else if (mode === "shutdown") {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const work = Effect.runPromise(
        PlanPublication.run(
          [file],
          Effect.promise(async () => {
            entered.resolve()
            await release.promise
            await writeFile(file, "original joined")
          }),
        ),
      )
      await entered.promise
      const retired = PlanPublication.drain()
      const shutdown = KiloShutdown.run()
      let joined = false
      const settled = shutdown.then(() => {
        joined = true
      })
      try {
        await assert.rejects(Effect.runPromise(PlanPublication.run([file], Effect.void)), /retired/)
        await Bun.sleep(25)
        assert.equal(joined, false)
      } finally {
        release.resolve()
      }
      const results = await Promise.allSettled([work, settled, retired])
      for (const result of results) if (result.status === "rejected") throw result.reason
      assert.equal(await readFile(file, "utf8"), "original joined")
    } else if (mode === "rebind") {
      const release = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const gate = coordinateNativeRoots([{ kind: "json", path: plans }], async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const work = assert.rejects(run(FSUtil.Service.use((fs) => io.exclusive(fs, file, "forbidden"))), (err) =>
        reasons(err).some((reason) => /namespace|canonical/.test(reason)),
      )
      const name = "raya.profile.json:" + (process.platform === "win32" ? data.toLowerCase() : data)
      const writers = path.join(path.dirname(data), ".raya-profile-locks", Hash.fast(name) + ".writers")
      try {
        const stop = Date.now() + 5000
        while (
          !(
            await readdir(writers).catch((err) => {
              if (err.code === "ENOENT") return []
              throw err
            })
          ).length
        ) {
          assert(Date.now() < stop)
          await Bun.sleep(10)
        }
        await rename(plans, path.join(data, "original"))
        await mkdir(plans)
        await writeFile(file, "foreign bytes")
      } finally {
        release.resolve()
      }
      const results = await Promise.allSettled([gate, work])
      for (const result of results) if (result.status === "rejected") throw result.reason
      assert.equal(await readFile(file, "utf8"), "foreign bytes")
      await assert.rejects(KiloShutdown.run(), /retirement failed/)
    } else if (mode === "errors") {
      const original = new Error("original body failure")
      await assert.rejects(
        Effect.runPromise(
          PlanPublication.run(
            [file],
            Effect.promise(async () => {
              await rename(plans, path.join(data, "retained"))
              await mkdir(plans)
              throw original
            }),
          ),
        ),
        (err) =>
          reasons(err).some((reason) => reason.includes("original body failure")) &&
          reasons(err).some((reason) => reason.includes("namespace changed")),
      )
      await assert.rejects(KiloShutdown.run(), /retirement failed/)
    } else if (mode === "competing") {
      const entered = path.join(root, "second")
      const child = {
        joined: undefined as Promise<unknown> | undefined,
      }
      await Effect.runPromise(
        PlanPublication.run(
          [file],
          Effect.promise(async () => {
            const proc = Bun.spawn([process.execPath, "--conditions=browser", import.meta.filename, root, "peer"], {
              env: process.env,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              windowsHide: true,
            })
            child.joined = Promise.all([
              proc.exited,
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]).then(([code, out, err]) => {
              assert.equal(code, 0, err)
              assert.equal(JSON.parse(out).joined, true)
            })
            const stop = Date.now() + 5000
            while (
              !(await readFile(path.join(root, "attempted")).catch((err) => {
                if (err.code === "ENOENT") return undefined
                throw err
              }))
            ) {
              assert(Date.now() < stop)
              await Bun.sleep(10)
            }
            await Bun.sleep(125)
            await assert.rejects(readFile(entered), { code: "ENOENT" })
            await writeFile(file, "first")
          }),
        ),
      ).finally(async () => {
        if (child.joined) await child.joined
      })
      assert.equal(await readFile(file, "utf8"), "second")
      assert.equal(await readFile(entered, "utf8"), "entered after original release")
    } else if (mode === "peer") {
      await writeFile(path.join(root, "attempted"), "original admission attempted")
      await Effect.runPromise(
        PlanPublication.run(
          [file],
          Effect.promise(async () => {
            await writeFile(path.join(root, "second"), "entered after original release")
            await writeFile(file, "second")
          }),
        ),
      )
    } else if (mode === "reparse") {
      await rename(plans, path.join(data, "real"))
      await symlink(path.join(data, "real"), plans, process.platform === "win32" ? "junction" : "dir")
      await assert.rejects(run(FSUtil.Service.use((fs) => io.exclusive(fs, file, "forbidden"))), /canonical/)
      await assert.rejects(readFile(file), { code: "ENOENT" })
    } else if (mode === "limit") {
      await assert.rejects(run(FSUtil.Service.use((fs) => io.exclusive(fs, file, "x".repeat(1048577)))), /byte limit/)
      await assert.rejects(readFile(file), { code: "ENOENT" })
      await assert.rejects(KiloShutdown.run(), /retirement failed/)
    } else if (["sidecar", "stale", "schema", "sidecar-failure"].includes(mode)) {
      const { save } = await import("../../../src/kilocode/plan-sidecar")
      const { PlanArtifact } = await import("../../../src/kilocode/plan-artifact")
      const text = "# Genuine plan\n\n1. Actual step café 日本語 🙂\n"
      await run(FSUtil.Service.use((fs) => io.exclusive(fs, file, text)))
      const before = await run(FSUtil.Service.use((fs) => io.read(fs, file)))
      const value = PlanArtifact.parse(before.text)
      const target = PlanArtifact.sidecar(file)
      if (mode === "sidecar") {
        const result = await run(PlanArtifact.save(file, value, before.sha256))
        assert.equal(result.source, before.sha256)
        assert.deepEqual(JSON.parse(await readFile(target, "utf8")), value)
        const prior = await stat(target)
        await run(PlanArtifact.save(file, value, before.sha256))
        assert.equal((await stat(target)).mode & 0o777, prior.mode & 0o777)
      } else {
        if (mode === "stale") await writeFile(file, "# Changed markdown\n")
        if (mode === "sidecar-failure") {
          await writeFile(target, "foreign sidecar")
          await link(target, path.join(root, "foreign"))
        }
        const invalid = mode === "schema" ? { ...value, title: 42 } : value
        await assert.rejects(
          run(mode === "schema" ? save(file, invalid, before.sha256) : PlanArtifact.save(file, value, before.sha256)),
        )
        if (mode === "sidecar-failure") assert.equal(await readFile(target, "utf8"), "foreign sidecar")
        else await assert.rejects(readFile(target), { code: "ENOENT" })
        await assert.rejects(KiloShutdown.run(), /retirement failed/)
      }
    } else if (["patch", "rollback", "rollback-failure", "recover"].includes(mode)) {
      const { transact, recover } = await import("../../../src/kilocode/tool/apply-patch-transaction")
      const { journals } = await import("../../../src/kilocode/tool/mutation-journal")
      const { Storage } = await import("../../../src/storage/storage")
      const { Git } = await import("../../../src/git")
      const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
      const hash = (text: string) => createHash("sha256").update(text).digest("hex")
      const dir = path.join(root, "storage")
      await mkdir(dir)
      await writeFile(path.join(dir, "migration"), "2")
      await writeFile(file, "before")
      const prior = await stat(file, { bigint: true })
      if (mode === "rollback-failure") await writeFile(path.join(plans, ".raya-txn-0.hold"), "foreign hold")
      const other = path.join(plans, "second.md")
      const anchor = await stat(plans, { bigint: true })
      const input = {
        invocation: mode,
        digest: hash("actual " + mode),
        workspace: root,
        items: [
          {
            entry: {
              kind: "replace" as const,
              target: file,
              stage: path.join(plans, ".raya-txn-0.stage"),
              hold: path.join(plans, ".raya-txn-0.hold"),
              review: {
                identity: { dev: String(prior.dev), ino: String(prior.ino) },
                sha256: hash("before"),
              },
              result: { sha256: hash("after") },
            },
            data: Buffer.from("after"),
          },
          {
            entry: {
              kind: "create" as const,
              target: other,
              stage: path.join(plans, ".raya-txn-1.stage"),
              anchor: { path: plans, identity: { dev: String(anchor.dev), ino: String(anchor.ino) } },
              result: { sha256: hash("created") },
            },
            ...(["patch", "recover"].includes(mode) ? { data: Buffer.from("created") } : {}),
          },
        ],
      }
      const providers = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))
      const work = Effect.gen(function* () {
        const storage = yield* Storage.Service
        if (mode === "recover") {
          const { prepareTransaction, publishTransaction } = yield* Effect.promise(() => import("@kilocode/sandbox"))
          const journal = journals(storage)
          yield* PlanPublication.run(
            input.items
              .flatMap((item) => [
                item.entry.target,
                item.entry.stage,
                ...("hold" in item.entry ? [item.entry.hold] : []),
              ])
              .filter((file): file is string => file !== undefined),
            Effect.gen(function* () {
              const admitted = yield* journal.admit({ ...input, entries: input.items.map((item) => item.entry) })
              assert(admitted.owned)
              const state = { outcome: admitted.outcome, entries: [...admitted.outcome.entries] }
              const advance = (phase: typeof state.outcome.phase, cursor: number) =>
                Effect.gen(function* () {
                  state.outcome = yield* journal.advance(mode, {
                    token: admitted.token,
                    revision: state.outcome.revision,
                    phase,
                    cursor,
                    entries: state.entries,
                  })
                })
              for (const [index, item] of input.items.entries()) {
                assert(item.data)
                state.entries[index] = {
                  ...state.entries[index],
                  artifact: yield* prepareTransaction(item.entry, item.data),
                }
                yield* advance("staging", index + 1)
              }
              yield* advance("prepared", state.entries.length)
              yield* advance("committing", 0)
              for (const [index, entry] of state.entries.entries()) {
                yield* publishTransaction(entry)
                yield* advance("committing", index + 1)
              }
              yield* advance("committed", state.entries.length)
            }),
          )
          const info = yield* Effect.promise(() => stat(file))
          assert.equal(info.nlink, 2)
        }
        const result = yield* Effect.exit(
          mode === "recover" ? recover(storage, mode, () => Effect.succeed(true)) : transact(storage, input),
        )
        const outcome = yield* journals(storage).get(mode)
        assert.equal(outcome?.phase, mode === "rollback-failure" ? "conflict" : "done")
        assert.equal(
          outcome?.decision,
          mode === "rollback-failure" ? undefined : ["patch", "recover"].includes(mode) ? "commit" : "rollback",
        )
        assert.equal(result._tag, ["patch", "recover"].includes(mode) ? "Success" : "Failure")
        if (mode === "rollback-failure") {
          assert(outcome?.reason?.includes("Mutation bytes are missing"))
          assert(outcome?.reason?.includes("hold is owned by another writer"))
        }
      }).pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.provide(providers))
      await Effect.runPromise(work)
      assert.equal(await readFile(file, "utf8"), ["patch", "recover"].includes(mode) ? "after" : "before")
      if (["patch", "recover"].includes(mode)) assert.equal(await readFile(other, "utf8"), "created")
      else await assert.rejects(readFile(other), { code: "ENOENT" })
      if (mode === "rollback-failure") {
        assert.equal(await readFile(path.join(plans, ".raya-txn-0.hold"), "utf8"), "foreign hold")
        assert.equal(await readFile(path.join(plans, ".raya-txn-0.stage"), "utf8"), "after")
      } else assert(!(await readdir(plans)).some((name) => name.startsWith(".raya-txn-")))
      if (!["patch", "recover"].includes(mode)) await assert.rejects(KiloShutdown.run(), /retirement failed/)
    } else if (mode === "outside") {
      await KiloShutdown.run()
      const outside = path.join(root, "ordinary.md")
      await run(FSUtil.Service.use((fs) => io.exclusive(fs, outside, "unchanged unrelated behavior")))
      assert.equal(await readFile(outside, "utf8"), "unchanged unrelated behavior")
    } else throw new Error("Unknown plan fixture mode")
    if (
      ![
        "maintenance",
        "shutdown",
        "rebind",
        "errors",
        "outside",
        "limit",
        "rollback",
        "rollback-failure",
        "stale",
        "schema",
        "sidecar-failure",
      ].includes(mode)
    )
      await KiloShutdown.run()
  } finally {
    if (mode === "errors") {
      await assert.rejects(closeProcessProfile(), /ENOENT|marker|profile/i)
      profile = false
    } else await closeProcessProfile()
  }
})
console.log(JSON.stringify({ mode, joined: true, profile, uncertainty: !profile }))
