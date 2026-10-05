import assert from "node:assert/strict"
import path from "node:path"
import { chmod, lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises"

const [root, mode, action] = process.argv.slice(2)
assert(root && mode)
assert(
  mode !== "account-default" || process.platform === "win32",
  "Default account environment fixture is Windows-only",
)
const home = path.join(root, mode === "account-default" ? "account" : "home")
const dir = path.join(root, "config", "kilo")
const file = path.join(dir, "kilo.jsonc")
await Promise.all([mkdir(home, { recursive: true }), mkdir(dir, { recursive: true })])
for (const key of Object.keys(process.env)) if (/^(RAYA|KILO|OPENCODE|OTEL)_/.test(key)) delete process.env[key]
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: mode === "account-default" ? home.replaceAll(path.sep, "/") : home,
  KILO_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  RAYA_DB: ":memory:",
  KILO_DB: ":memory:",
  KILO_AUTH_CONTENT: "{}",
  RAYA_AUTH_CONTENT: "{}",
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
  KILO_DISABLE_AUTOUPDATE: "1",
  KILO_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
})
const { ConfigPublication } = await import("../../../src/kilocode/config/publication")
const { KilocodeMcpConfig } = await import("../../../src/kilocode/cli/cmd/mcp")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { closeProcessProfile, processProfileSnapshot } = await import("@opencode-ai/core/kilocode/process-profile")
const { coordinateNativeRoots } = await import("@opencode-ai/core/kilocode/profile-maintenance")
const { Hash } = await import("@opencode-ai/core/util/hash")
const { ConfigSetup } = await import("../../../src/kilocode/config/setup")
const { parse, modify, applyEdits } = await import("jsonc-parser")
const text =
  '// preserved café 日本語\n{"$schema":"https://app.kilo.ai/config.json","permission":"deny","model":"synthetic/original","provider":{"synthetic":{"options":{"future":{"keep":7}}}}}\n'
const results: string[] = []
let runtime: typeof import("../../../src/effect/app-runtime").AppRuntime | undefined
async function ready(file: string) {
  const end = Date.now() + 5000
  while (
    !(
      await readdir(file).catch((err) => {
        if (err.code === "ENOENT") return []
        throw err
      })
    ).length
  ) {
    assert(Date.now() < end, "actual writer readiness")
    await Bun.sleep(10)
  }
}
const scope: typeof ConfigPublication.using =
  mode === "account-default" ? (_root, body) => body() : ConfigPublication.using
await scope(root, async () => {
  try {
    if (mode !== "worker") await writeFile(file, text)
    if (mode === "worker") {
      if (action === "mcp")
        await KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true)
      if (action === "global") {
        const { AppRuntime } = await import("../../../src/effect/app-runtime")
        const { Config } = await import("../../../src/config/config")
        runtime = AppRuntime
        await AppRuntime.runPromise(
          Config.Service.use((cfg) => cfg.updateGlobal({ model: "synthetic/changed" }, { dispose: false })),
        )
      }
      await KiloShutdown.run()
      results.push("actual-public-writer")
    } else if (mode === "mixed") {
      const children = ["mcp", "global"].map((action) =>
        Bun.spawn([process.execPath, "--conditions=browser", import.meta.filename, root, "worker", action], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        }),
      )
      const joins = await Promise.allSettled(
        children.map((child) =>
          Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
        ),
      )
      for (const result of joins) {
        if (result.status !== "fulfilled") throw result.reason
        const [code, out, err] = result.value
        assert.equal(code, 0, err)
        assert(out.includes("actual-public-writer"))
      }
      const after = await readFile(file, "utf8")
      const data = parse(after)
      assert.equal(data.model, "synthetic/changed")
      assert.equal(data.mcp.synthetic.command[0], "unused")
      assert.equal(data.provider.synthetic.options.future.keep, 7)
      assert(after.includes("// preserved café 日本語"))
      results.push("two-original-processes-and-streams-joined", "actual-MCP-and-global-update-no-lost-edit")
    } else if (mode === "account" || mode === "account-default") {
      const account = path.join(root, "account")
      const folder = path.join(account, "config")
      const schema = path.join(folder, "existing.jsonc")
      const seed = path.join(folder, "new", "kilo.json")
      await mkdir(folder, { recursive: true })
      await writeFile(schema, '// retained\n{"permission":"deny","future":7}')
      const before = await lstat(account, { bigint: true })
      await scope(account, async () => {
        await Promise.all([ConfigSetup.schema(schema), ConfigSetup.seed([seed], seed)])
      })
      assert.equal(parse(await readFile(schema, "utf8")).future, 7)
      assert.equal(parse(await readFile(schema, "utf8")).$schema, "https://app.kilo.ai/config.json")
      assert.equal(parse(await readFile(seed, "utf8")).$schema, "https://app.kilo.ai/config.json")
      const after = await lstat(account, { bigint: true })
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
      assert(!(await readdir(root)).includes(".raya-profile-locks"), "account container must remain read-only")
      assert((await readdir(account)).includes(".raya-profile-locks"), "metadata admission remains inside account")
      assert((await readdir(account)).includes(".raya-config-rmw-locks"))
      results.push("actual-concurrent-schema-and-seed", "account-container-never-leased")
    } else if (mode === "setup") {
      await writeFile(file, '// untouched\n{"permission":"deny","future":{"keep":7}}')
      await chmod(file, 0o644)
      const mode = (await lstat(file)).mode & 0o777
      await Promise.all([
        ConfigSetup.schema(file),
        KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true),
      ])
      const after = await readFile(file, "utf8")
      assert(after.includes("// untouched"))
      assert.equal(parse(after).future.keep, 7)
      assert.equal(parse(after).mcp.synthetic.command[0], "unused")
      assert.equal(parse(after).$schema, "https://app.kilo.ai/config.json")
      assert.equal((await lstat(file)).mode & 0o777, mode)
      results.push("actual-schema-and-MCP-serialized", "comments-and-unknown-fields-preserved")
    } else if (mode === "maintenance") {
      const release = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const gate = coordinateNativeRoots([{ kind: "json", path: dir }], async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const work = KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true)
      const shutdown = KiloShutdown.run()
      const joined = assert.doesNotReject(shutdown)
      await Promise.resolve()
      await assert.rejects(
        KilocodeMcpConfig.add(file, "late", { type: "local", command: ["unused"] }, dir, true),
        /retired/,
      )
      assert.equal(await readFile(file, "utf8"), text)
      release.resolve()
      await gate
      assert.equal(await work, file)
      await joined
      results.push("maintenance-before-effects", "shutdown-original-publication-joined")
    } else if (mode === "rebind") {
      const deferred = Promise.withResolvers<Promise<void>>()
      const blocker = path.join(root, "zzgate.json")
      await writeFile(blocker, "{}")
      await coordinateNativeRoots([{ kind: "json", path: blocker }], async () => {
        const work = ConfigPublication.promise({ files: [file, blocker], targets: [file] }, async (tx) => {
          const before = await tx.read(file)
          assert(before)
          await tx.write(file, before, before + "\n")
        })
        deferred.resolve(assert.rejects(work))
        const key = "raya.profile.json:" + (process.platform === "win32" ? dir.toLowerCase() : dir)
        await ready(path.join(path.dirname(dir), ".raya-profile-locks", Hash.fast(key) + ".writers"))
        await rename(dir, path.join(path.dirname(dir), "original"))
        await mkdir(dir)
        await writeFile(file, "foreign bytes")
      })
      await deferred.promise
      await assert.rejects(KiloShutdown.run(), /retirement failed/)
      assert.equal(await readFile(file, "utf8"), "foreign bytes")
      results.push("actual-rebind-refused", "foreign-bytes-preserved-and-failure-sticky")
    } else if (mode === "safe") {
      const alias = path.join(root, "alias")
      await symlink(dir, alias, process.platform === "win32" ? "junction" : "dir")
      await assert.rejects(
        ConfigPublication.promise({ files: [path.join(alias, "kilo.jsonc")] }, async (tx) =>
          tx.read(path.join(alias, "kilo.jsonc")),
        ),
        /canonical/,
      )
      await KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true)
      await KiloShutdown.run()
      results.push("safe-alias-refusal", "safe-refusal-not-sticky")
    } else if (mode === "lock") {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const work = ConfigPublication.promise({ files: [file] }, async (tx) => {
        assert.equal(await tx.read(file), text)
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const writer = KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true)
      const shutdown = KiloShutdown.run()
      let settled = false
      const joined = shutdown.then(() => {
        settled = true
      })
      await Bun.sleep(75)
      assert.equal(settled, false)
      assert.equal(await readFile(file, "utf8"), text)
      await assert.rejects(
        KilocodeMcpConfig.add(file, "late", { type: "local", command: ["unused"] }, dir, true),
        /retired/,
      )
      release.resolve()
      const joins = await Promise.allSettled([work, writer, joined])
      for (const result of joins) if (result.status === "rejected") throw result.reason
      assert.equal(parse(await readFile(file, "utf8")).mcp.synthetic.command[0], "unused")
      assert.equal(settled, true)
      results.push("original-common-lock-retained-until-body-join", "shutdown-joins-both-writers-no-replay")
    } else if (mode === "console") {
      const { KilocodeConfigWriter } = await import("../../../src/kilocode/config/writer")
      const { KilocodeConfigOverlay } = await import("../../../src/kilocode/config/overlay")
      const target = await KilocodeConfigOverlay.target({ directory: dir, scope: "global" })
      const joins = await Promise.allSettled([
        KilocodeConfigWriter.write({ directory: dir, scope: "global", set: { model: "synthetic/console" } }),
        KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true),
      ])
      for (const result of joins) if (result.status === "rejected") throw result.reason
      const data = parse(await readFile(file, "utf8"))
      assert.equal(data.model, "synthetic/console")
      assert.equal(data.mcp.synthetic.command[0], "unused")
      const refused = await KilocodeConfigWriter.write({
        directory: dir,
        scope: "global",
        expected: target,
        set: { model: "synthetic/stale" },
      })
      assert.equal(refused.ok, false)
      if (!refused.ok) assert.equal(refused.code, "revision-conflict")
      results.push("actual-console-and-MCP", "stale-console-no-publication")
    } else if (mode === "legacy") {
      await chmod(file, 0o640)
      const mode = (await lstat(file)).mode & 0o777
      const source = path.join(dir, "config")
      await writeFile(source, 'provider = "synthetic"\nmodel = "legacy"\n')
      const { mergeDeep } = await import("remeda")
      await Promise.all([
        ConfigSetup.legacy([file], source, file, (before, patch) => mergeDeep(before as object, patch as object)),
        KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true),
      ])
      const data = parse(await readFile(file, "utf8"))
      assert.equal(data.model, "synthetic/legacy")
      assert.equal((await lstat(file)).mode & 0o777, mode)
      assert.equal(data.mcp.synthetic.command[0], "unused")
      await assert.rejects(readFile(source), { code: "ENOENT" })
      results.push("actual-legacy-delta-not-stale-aggregate", "original-legacy-unlink-after-publication")
    } else if (mode === "seed") {
      await unlink(file)
      await Promise.all([
        ConfigSetup.seed([file], file),
        KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true),
      ])
      const data = parse(await readFile(file, "utf8"))
      assert.equal(data.mcp.synthetic.command[0], "unused")
      assert(data.$schema === undefined || data.$schema === "https://app.kilo.ai/config.json")
      results.push("actual-seed-create-only", "competing-creator-preserved")
    } else if (mode === "bash") {
      await writeFile(file, '// migration comment\n{"model":"synthetic/original"}')
      const { KilocodeConfig } = await import("../../../src/kilocode/config/config")
      await Promise.all([
        KilocodeConfig.migrateBashPermission(),
        KilocodeMcpConfig.add(file, "synthetic", { type: "local", command: ["unused"] }, dir, true),
      ])
      const data = parse(await readFile(file, "utf8"))
      assert.equal(data.permission.bash, "allow")
      assert.equal(data.mcp.synthetic.command[0], "unused")
      assert((await readFile(file, "utf8")).includes("// migration comment"))
      results.push("actual-bash-migration-and-MCP", "fresh-destination-and-comment-preserved")
    } else if (mode === "layered") {
      const second = path.join(dir, "opencode.jsonc")
      await writeFile(
        second,
        '// second layer\n{"provider":{"synthetic":{"options":{"future":{"other":8},"keep":true}}}}',
      )
      const { AppRuntime } = await import("../../../src/effect/app-runtime")
      const { Config } = await import("../../../src/config/config")
      runtime = AppRuntime
      await AppRuntime.runPromise(
        Config.Service.use((cfg) =>
          cfg.updateGlobal({ provider: { synthetic: { options: { future: null } } } }, { dispose: false }),
        ),
      )
      for (const target of [file, second]) {
        const value = parse(await readFile(target, "utf8"))
        assert.equal(value.provider.synthetic.options.future, undefined)
      }
      assert.equal(parse(await readFile(second, "utf8")).provider.synthetic.options.keep, true)
      results.push("actual-global-layered-unset", "other-fields-retained-across-all-members")
    } else if (mode === "project") {
      const project = path.join(root, "project")
      await mkdir(project)
      const target = path.join(project, "kilo.jsonc")
      await writeFile(
        target,
        '// project comment\n{"agent":{"synthetic":{"prompt":"synthetic only"}},"default_agent":"synthetic","provider":{"synthetic":{"options":{"keep":7}}}}',
      )
      const { provideTestInstance, disposeTestRuntime } = await import("../../fixture/fixture")
      const { AppRuntime } = await import("../../../src/effect/app-runtime")
      const { Config } = await import("../../../src/config/config")
      const { Effect } = await import("effect")
      const { InstanceRef } = await import("../../../src/effect/instance-ref")
      const { remove } = await import("../../../src/kilocode/agent")
      runtime = AppRuntime
      try {
        await provideTestInstance({
          directory: project,
          fn: async (ctx) => {
            const joins = await Promise.allSettled([
              AppRuntime.runPromise(
                Config.Service.use((cfg) => cfg.update({ model: "synthetic/project" })).pipe(
                  Effect.provideService(InstanceRef, ctx),
                ),
              ),
              remove({
                name: "synthetic",
                agent: { name: "synthetic", mode: "subagent", native: false, permission: [], options: {} },
                dirs: [],
                directory: project,
                worktree: project,
                scope: "project",
              }),
            ])
            for (const result of joins) if (result.status === "rejected") throw result.reason
          },
        })
      } finally {
        await disposeTestRuntime()
      }
      const value = parse(await readFile(target, "utf8"))
      assert.equal(value.agent.synthetic, undefined)
      assert.equal(value.default_agent, undefined)
      assert.equal(value.model, "synthetic/project")
      assert.equal(value.provider.synthetic.options.keep, 7)
      results.push("actual-project-update-and-agent-removal", "comments-and-unrelated-provider-preserved")
    } else if (mode === "stale") {
      const { ConfigIntent } = await import("@opencode-ai/core/kilocode/config-intent")
      const graph = ConfigIntent.graph("v1", {
        data: path.join(root, "data"),
        config: dir,
        state: path.join(root, "state"),
      })
      const loaded = parse(text)
      await ConfigIntent.loaded(graph, loaded, file, text)
      ConfigIntent.ordered(graph, [loaded])
      await writeFile(file, text.replace("synthetic/original", "synthetic/external"))
      await assert.rejects(
        ConfigPublication.promise({ files: [file] }, async (tx) => {
          const before = await tx.read(file)
          assert(before)
          await tx.write(file, before, before.replace("synthetic/external", "synthetic/forbidden"))
        }),
        /loaded|predecessor|origin|changed|graph/i,
      )
      assert((await readFile(file, "utf8")).includes("synthetic/external"))
      await assert.rejects(KiloShutdown.run(), /retirement failed/)
      results.push("actual-stale-loaded-graph-refusal", "no-publication-no-replay")
    } else if (mode === "partial") {
      const second = path.join(dir, "second.json")
      await writeFile(second, "{}")
      const error = new Error("original second publication refusal")
      await assert.rejects(
        ConfigPublication.promise({ files: [file, second] }, async (tx) => {
          const before = await tx.read(file)
          assert(before)
          await tx.write(file, before, applyEdits(before, modify(before, ["model"], "synthetic/committed", {})))
          throw error
        }),
        (err) => err === error,
      )
      assert.equal(parse(await readFile(file, "utf8")).model, "synthetic/committed")
      assert.equal(await readFile(second, "utf8"), "{}")
      await assert.rejects(
        KiloShutdown.run(),
        (err: unknown) => err instanceof AggregateError && err.errors.includes(error),
      )
      results.push("first-commit-retained-with-original-later-error", "no-replay-and-sticky-retirement")
    } else throw new Error("Unknown fixture mode")
    if (mode !== "maintenance" && mode !== "partial" && mode !== "safe" && mode !== "rebind" && mode !== "stale")
      await KiloShutdown.run()
  } finally {
    await runtime?.dispose()
    await closeProcessProfile()
  }
})
assert(processProfileSnapshot().terminal)
console.log(JSON.stringify({ mode, results, terminal: true }))
