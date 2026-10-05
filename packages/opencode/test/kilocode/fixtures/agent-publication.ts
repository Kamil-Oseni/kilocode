import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises"

const [root, mode] = process.argv.slice(2)
assert(root && mode)
const home = path.join(root, "home")
const workspace = path.join(root, "workspace")
await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })])
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
const { AgentPublication } = await import("../../../src/kilocode/cli/agent-publication")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { closeProcessProfile, processProfileSnapshot } = await import("@opencode-ai/core/kilocode/process-profile")
const { coordinateNativeRoots } = await import("@opencode-ai/core/kilocode/profile-maintenance")
const { Flock } = await import("@opencode-ai/core/util/flock")
const { Hash } = await import("@opencode-ai/core/util/hash")
const dir = path.join(workspace, "agents")
const text = "---\ndescription: Disposable agent\nmode: primary\n---\nPrivate café 日本語 🙂\n"
const results: string[] = []
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
    assert(Date.now() < end, "original writer readiness deadline")
    await Bun.sleep(10)
  }
}
try {
  if (mode === "worker") {
    const created = await AgentPublication.save(dir, "shared", text)
    await KiloShutdown.run()
    console.log(JSON.stringify({ created }))
  } else if (mode === "competing") {
    const fixture = import.meta.filename
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, fixture, root, "worker"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      }),
    )
    const rows = await Promise.all(
      children.map(async (child) => {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        assert.equal(code, 0, err)
        assert.equal(err, "")
        const value: unknown = JSON.parse(out)
        assert(value && typeof value === "object" && "created" in value && typeof value.created === "boolean")
        return value.created
      }),
    )
    assert.equal(rows.filter(Boolean).length, 1)
    assert.equal(await readFile(path.join(dir, "shared.md"), "utf8"), text)
    await KiloShutdown.run()
    results.push("two-original-processes-joined", "one-create-no-overwrite")
  } else if (mode === "safe") {
    const other = path.join(root, "other")
    const alias = path.join(root, "alias")
    await mkdir(other)
    await symlink(other, alias, process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(AgentPublication.save(path.join(alias, "agents"), "first", text), /canonical/)
    assert.equal(await AgentPublication.save(dir, "first", text), true)
    await KiloShutdown.run()
    assert.equal(await Bun.file(path.join(other, "agents/first.md")).exists(), false)
    results.push("pre-effect-reparse-refused", "safe-refusal-not-sticky")
  } else if (mode === "failure") {
    await mkdir(path.join(dir, "first.md"), { recursive: true })
    const failure = await AgentPublication.save(dir, "first", text).then(
      () => {
        throw new Error("Actual invalid target unexpectedly published")
      },
      (err) => err as unknown,
    )
    assert(failure instanceof Error)
    await assert.rejects(
      KiloShutdown.run(),
      (err: unknown) => err instanceof AggregateError && err.errors.includes(failure),
    )
    await assert.rejects(AgentPublication.save(dir, "late", text), /retired/)
    results.push("actual-publication-refusal-sticky", "late-fenced")
  } else if (mode === "rebind") {
    await mkdir(dir)
    const deferred = Promise.withResolvers<Promise<void>>()
    await coordinateNativeRoots([{ kind: "json", path: dir }], async () => {
      deferred.resolve(
        assert.rejects(
          AgentPublication.save(dir, "first", text),
          (err: unknown) =>
            err instanceof AggregateError &&
            err.errors.length >= 2 &&
            err.errors.every((value) => value.message.includes("namespace changed")),
        ),
      )
      const key = "raya.profile.json:" + (process.platform === "win32" ? workspace.toLowerCase() : workspace)
      await ready(path.join(root, ".raya-profile-locks", Hash.fast(key) + ".writers"))
      await rename(dir, path.join(workspace, "original"))
      await mkdir(dir)
      await writeFile(path.join(dir, "foreign.txt"), "preserve replacement")
    })
    await deferred.promise
    await assert.rejects(KiloShutdown.run(), /retirement failed/)
    assert.equal(await readFile(path.join(dir, "foreign.txt"), "utf8"), "preserve replacement")
    assert.equal(await Bun.file(path.join(dir, "first.md")).exists(), false)
    results.push("body-and-final-check-failures-retained", "foreign-replacement-preserved")
  } else if (mode === "lock") {
    await mkdir(dir)
    const target = path.join(dir, "first.md")
    const lock = await Flock.acquire("agent-create:" + (process.platform === "win32" ? target.toLowerCase() : target), {
      dir: path.join(workspace, ".agent-create-locks"),
      recover: false,
    })
    const work = AgentPublication.save(dir, "first", text)
    const key = "raya.profile.json:" + (process.platform === "win32" ? dir.toLowerCase() : dir)
    await ready(path.join(workspace, ".raya-profile-locks", Hash.fast(key) + ".writers"))
    const shutdown = KiloShutdown.run()
    const joined = assert.doesNotReject(shutdown)
    assert.equal(await Bun.file(target).exists(), false)
    await assert.rejects(AgentPublication.save(dir, "late", text), /retired/)
    await lock.release()
    assert.equal(await work, true)
    await joined
    assert.equal(await readFile(target, "utf8"), text)
    results.push("per-target-publication-exclusion", "original-lock-and-shutdown-joined")
  } else {
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const gate = coordinateNativeRoots([{ kind: "json", path: workspace }], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const work = AgentPublication.save(dir, "first", text)
    const shutdown = KiloShutdown.run()
    const joined = assert.doesNotReject(shutdown)
    await Promise.resolve()
    await assert.rejects(AgentPublication.save(dir, "late", text), /retired/)
    assert.equal(await Bun.file(path.join(dir, "first.md")).exists(), false)
    assert.equal(await Bun.file(path.join(dir, "late.md")).exists(), false)
    release.resolve()
    await gate
    assert.equal(await work, true)
    await joined
    assert.equal(await readFile(path.join(dir, "first.md"), "utf8"), text)
    results.push("maintenance-before-effects", "shutdown-joins-original-publication")
  }
  if (mode !== "worker" && mode !== "competing") {
    const roots = processProfileSnapshot().roots
    if (mode !== "rebind") assert(roots.includes(workspace) && roots.includes(dir))
  }
} finally {
  await closeProcessProfile()
}
if (mode !== "worker") {
  await writeFile(
    path.join(root, "receipt.json"),
    JSON.stringify({ mode, results, terminal: processProfileSnapshot().terminal }),
    { flag: "wx" },
  )
  console.log(JSON.stringify({ mode, results }))
}
