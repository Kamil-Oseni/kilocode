import assert from "node:assert/strict"
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

const [root, mode] = process.argv.slice(2)
assert(root && mode)
const home = path.join(root, "home")
const workspace = path.join(root, "workspace")
await Promise.all([mkdir(home), mkdir(workspace)])
for (const key of Object.keys(process.env)) if (/^(KILO|RAYA|OPENCODE|OTEL)_/.test(key)) delete process.env[key]
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
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
})
const { AgentBuilder } = await import("../../../src/kilocode/agent/builder")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { coordinateNativeRoots, resolveProfileRoot } = await import("@opencode-ai/core/kilocode/profile-maintenance")
const { closeProcessProfile, processProfileSnapshot } = await import("@opencode-ai/core/kilocode/process-profile")
const { Hash } = await import("@opencode-ai/core/util/hash")
const input = (id: string) => ({
  id,
  scope: "project" as const,
  mode: "primary" as const,
  prompt: `Private café 日本語 😀 ${id}`,
})
const directory = path.join(workspace, ".kilo", "agent")
const results: string[] = []
try {
  if (mode === "failure") {
    await mkdir(directory, { recursive: true })
    await mkdir(path.join(directory, "failed.md"))
    await assert.rejects(AgentBuilder.save({ directory: workspace }, input("failed")), AggregateError)
    await assert.rejects(KiloShutdown.run(), /Agent builder retirement failed/)
    await assert.rejects(AgentBuilder.save({ directory: workspace }, input("late")), /retired/)
    assert((await stat(path.join(directory, "failed.md"))).isDirectory())
    results.push("actual-write-failure-sticky", "late-no-mutation")
  } else if (mode === "alias") {
    await mkdir(directory, { recursive: true })
    const external = path.join(root, "external.md")
    const target = path.join(directory, "alias.md")
    await writeFile(external, "private original")
    const linked = await symlink(external, target, "file").then(
      () => true,
      async (err) => {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(err.code)) throw err
        const external = path.join(root, "external")
        await mkdir(external)
        await symlink(external, target, "junction")
        return false
      },
    )
    await assert.rejects(AgentBuilder.save({ directory: workspace }, input("alias")), /outside its admitted directory/)
    assert.equal(await readFile(external, "utf8"), "private original")
    await assert.rejects(KiloShutdown.run(), /Agent builder retirement failed/)
    results.push(
      linked ? "file-symlink-refused" : "junction-target-refused-file-symlink-unavailable",
      "external-bytes-unchanged",
    )
  } else if (mode === "rebind") {
    await mkdir(directory, { recursive: true })
    const other = path.join(root, "other")
    const alias = path.join(root, "alias")
    await mkdir(other)
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir")
    const roots = await Promise.all([workspace, directory].map((path) => resolveProfileRoot({ kind: "json", path })))
    assert(roots[0].id < roots[1].id, "actual-scope-before-agent-admission")
    const deferred = Promise.withResolvers<Promise<void>>()
    await coordinateNativeRoots([{ kind: "json", path: await realpath(directory) }], async () => {
      const work = AgentBuilder.save({ directory: alias }, input("rebound"))
      deferred.resolve(assert.rejects(work, AggregateError))
      const key = `raya.profile.json:${process.platform === "win32" ? workspace.toLowerCase() : workspace}`
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
      results.push("accepted-original-root-before-rebind")
    })
    await deferred.promise
    await assert.rejects(KiloShutdown.run(), /Agent builder retirement failed/)
    assert.equal(await Bun.file(path.join(other, ".kilo/agent/rebound.md")).exists(), false)
    results.push("rebind-refused")
  } else {
    const scope = mode === "worktree" ? path.join(root, "worktree") : workspace
    if (mode === "worktree") await mkdir(scope)
    const agents = path.join(scope, ".kilo", "agent")
    if (mode === "directory") await mkdir(agents, { recursive: true })
    const selected = mode === "directory" ? agents : scope
    const release = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const gate = coordinateNativeRoots([{ kind: "json", path: await realpath(selected) }], async () => {
      ready.resolve()
      await release.promise
    })
    await ready.promise
    const ctx = mode === "worktree" ? { directory: workspace, worktree: scope } : { directory: scope }
    const first = input("first")
    const work = [AgentBuilder.save(ctx, first), AgentBuilder.save(ctx, input("second"))]
    first.id = "mutated"
    first.prompt = "mutated after accepted save"
    ctx.directory = home
    const joined = Promise.allSettled(work)
    const closing = KiloShutdown.run()
    const retired = assert.doesNotReject(closing)
    await Promise.resolve()
    await assert.rejects(AgentBuilder.save(ctx, input("late")), /retired/)
    for (const id of ["first", "second", "late", "mutated"])
      assert.equal(await Bun.file(path.join(agents, id + ".md")).exists(), false)
    assert.equal(await Bun.file(path.join(home, ".kilo/agent/late.md")).exists(), false)
    results.push("no-final-files-under-active-gate", "late-fenced")
    release.resolve()
    await gate
    await retired
    const outputs = await joined
    assert(outputs.every((value) => value.status === "fulfilled"))
    for (const value of outputs)
      if (value.status === "fulfilled") assert.equal(await readFile(value.value.path, "utf8"), value.value.markdown)
    const roots = processProfileSnapshot().roots
    assert(roots.includes(await realpath(scope)) && roots.includes(await realpath(agents)))
    results.push("parallel-accepted-saves-joined", "scope-and-agent-lifetimes-owned")
  }
} finally {
  await closeProcessProfile()
}
await writeFile(
  path.join(root, "receipt.json"),
  JSON.stringify({ mode, results, terminal: processProfileSnapshot().terminal }),
  { flag: "wx" },
)
console.log(JSON.stringify({ mode, results }))
