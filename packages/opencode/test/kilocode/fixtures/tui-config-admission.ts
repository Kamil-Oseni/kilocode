import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"

const [root, mode] = process.argv.slice(2)
assert(root && mode)
const home = path.join(root, "home")
const workspace = path.join(root, "workspace")
await Promise.all([mkdir(home), mkdir(workspace)])
for (const key of Object.keys(process.env)) if (/^(RAYA|KILO|OPENCODE|OTEL)_/.test(key)) delete process.env[key]
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  KILO_TEST_HOME: home,
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_STATE_HOME: path.join(home, "state"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  RAYA_DB: ":memory:",
  KILO_DB: ":memory:",
  KILO_DISABLE_MODELS_FETCH: "1",
  RAYA_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
})
const { KilocodeTuiConfig } = await import("../../../src/kilocode/tui/config")
const { Global } = await import("@opencode-ai/core/global")
const { coordinateNativeRoots, coordinateProfileWriters, profileScope, resolveProfileRoot } = await import(
  "@opencode-ai/core/kilocode/profile-maintenance"
)
const { closeProcessProfile, processProfileSnapshot } = await import("@opencode-ai/core/kilocode/process-profile")
const { RuntimeRegistry } = await import("@opencode-ai/core/kilocode/runtime-registry")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { Hash } = await import("@opencode-ai/core/util/hash")
await mkdir(Global.Path.config, { recursive: true })
await writeFile(
  path.join(Global.Path.config, "kilo.json"),
  JSON.stringify({ enabled_providers: [], permission: "deny", formatter: false, lsp: false }),
)
const results: string[] = []
const scope = mode === "global" ? Global.Path.config : mode === "worktree" ? path.join(root, "worktree") : workspace
await mkdir(scope, { recursive: true })
const dir = mode === "global" ? scope : path.join(scope, ".kilo")
const file = path.join(dir, mode === "global" ? "tui.jsonc" : "tui.json")
const cwd = mode === "worktree" ? path.join(scope, "nested", "cwd") : scope
if (mode === "worktree") {
  await mkdir(cwd, { recursive: true })
  await mkdir(dir)
  await writeFile(file, '{"theme":"original"}')
}
const input = () => ({
  directory: cwd,
  worktree: scope,
  scope: mode === "global" ? ("global" as const) : ("project" as const),
  patch: { theme: "dracula" },
})
try {
  if (mode === "failure") {
    await mkdir(file, { recursive: true })
    await assert.rejects(KilocodeTuiConfig.update(input()), AggregateError)
    await assert.rejects(KiloShutdown.run(), /TUI config retirement failed/)
    await assert.rejects(KilocodeTuiConfig.update(input()), /retired/)
    assert((await stat(file)).isDirectory())
    results.push("actual-publication-failure-sticky", "late-refused")
  } else if (mode === "alias") {
    await mkdir(dir)
    const external = path.join(root, "external.json")
    await writeFile(external, '{"theme":"original"}')
    const linked = await symlink(external, file, "file").then(
      () => true,
      async (err) => {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(err.code)) throw err
        const outside = path.join(root, "external")
        await mkdir(outside)
        await symlink(outside, file, "junction")
        return false
      },
    )
    await assert.rejects(KilocodeTuiConfig.update(input()), /outside its admitted directory/)
    assert.equal(await readFile(external, "utf8"), '{"theme":"original"}')
    await assert.rejects(KiloShutdown.run(), /TUI config retirement failed/)
    results.push(
      linked ? "file-alias-refused" : "junction-target-refused-file-symlink-unavailable",
      "external-unchanged",
    )
  } else if (mode === "rebind") {
    await mkdir(dir)
    const other = path.join(root, "other")
    const alias = path.join(root, "alias")
    await mkdir(other)
    await symlink(scope, alias, process.platform === "win32" ? "junction" : "dir")
    const roots = await Promise.all([scope, dir].map((path) => resolveProfileRoot({ kind: "json", path })))
    assert(roots[0].id < roots[1].id)
    const joined = Promise.withResolvers<Promise<void>>()
    await coordinateNativeRoots([{ kind: "json", path: await realpath(dir) }], async () => {
      joined.resolve(
        assert.rejects(KilocodeTuiConfig.update({ ...input(), directory: alias, worktree: alias }), AggregateError),
      )
      const key = `raya.profile.json:${process.platform === "win32" ? scope.toLowerCase() : scope}`
      const writers = path.join(root, ".raya-profile-locks", Hash.fast(key) + ".writers")
      const end = Date.now() + 3000
      while (
        !(
          await readdir(writers).catch((err) => {
            if (err.code === "ENOENT") return []
            throw err
          })
        ).length
      ) {
        assert(Date.now() < end)
        await Bun.sleep(10)
      }
      await rm(alias)
      await symlink(other, alias, process.platform === "win32" ? "junction" : "dir")
    })
    await joined.promise
    await assert.rejects(KiloShutdown.run(), /TUI config retirement failed/)
    assert.equal(await Bun.file(path.join(other, ".kilo", "tui.json")).exists(), false)
    assert.equal(processProfileSnapshot().roots.includes(await realpath(other)), false)
    results.push("accepted-original-scope-before-rebind", "no-foreign-write-or-registration")
  } else {
    if (mode === "parent" || mode === "file") await mkdir(dir, { recursive: true })
    if (mode === "file") await writeFile(file, '{"theme":"original"}')
    const selected = mode === "parent" ? dir : mode === "file" ? file : scope
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const body = async () => {
      ready.resolve()
      await release.promise
    }
    const gate =
      mode === "global"
        ? coordinateProfileWriters(
            await profileScope({
              data: root,
              channel: "latest",
              disabled: false,
              override: path.join(root, "unused.db"),
              storage: scope,
            }),
            "cooperative-maintenance",
            body,
          )
        : coordinateNativeRoots([{ kind: "json", path: await realpath(selected) }], body)
    const held = assert.doesNotReject(gate)
    await ready.promise
    const before = (await Bun.file(file).exists()) ? await readFile(file, "utf8") : undefined
    const cfg = input()
    const joined = Promise.allSettled([
      KilocodeTuiConfig.update(cfg),
      KilocodeTuiConfig.update({ ...input(), patch: { keybinds: { app_exit: "ctrl+x" } } }),
    ])
    cfg.directory = home
    cfg.patch.theme = "mutated"
    const state = { saved: false, retired: false }
    const saved = joined.then(() => {
      state.saved = true
    })
    const retired = assert.doesNotReject(KiloShutdown.run())
    const closing = retired.then(() => {
      state.retired = true
    })
    await Promise.resolve()
    await assert.rejects(KilocodeTuiConfig.update(input()), /retired/)
    // Exercise accepted work while the actual gate is still held, before releasing it.
    const end = Date.now() + 150
    do {
      assert.equal((await Bun.file(file).exists()) ? await readFile(file, "utf8") : undefined, before)
      assert.equal(state.saved, false)
      assert.equal(state.retired, false)
      await Bun.sleep(10)
    } while (Date.now() < end)
    release.resolve()
    await held
    await closing
    await saved
    const outputs = await joined
    assert(
      outputs.every((value) => value.status === "fulfilled"),
      JSON.stringify(outputs),
    )
    const document = JSON.parse(await readFile(file, "utf8"))
    assert.equal(document.theme, "dracula")
    assert.equal(document.keybinds.app_exit, "ctrl+x")
    assert.equal(await Bun.file(path.join(home, ".kilo", "tui.json")).exists(), false)
    const roots = processProfileSnapshot().roots
    for (const entry of [scope, dir, file]) assert(roots.includes(await realpath(entry)))
    results.push(
      mode === "global" ? "global-cooperative-only-held" : "actual-native-root-held",
      "accepted-updates-joined",
      "late-fenced",
      "input-snapshot",
      "both-patches-retained",
    )
  }
} finally {
  await RuntimeRegistry.drain()
  await closeProcessProfile()
}
await writeFile(
  path.join(root, "receipt.json"),
  JSON.stringify({ mode, results, terminal: processProfileSnapshot().terminal }),
  { flag: "wx" },
)
console.log(JSON.stringify({ mode, results, passed: true }))
