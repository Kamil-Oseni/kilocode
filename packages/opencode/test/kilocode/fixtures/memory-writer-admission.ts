import assert from "node:assert/strict"
import path from "node:path"
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, symlink, utimes, writeFile } from "node:fs/promises"

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
  RAYA_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_MODELS_FETCH: "1",
})
const { Memory } = await import("@kilocode/kilo-memory/memory")
const { MemoryFiles } = await import("@kilocode/kilo-memory/store")
const { MemoryPaths } = await import("@kilocode/kilo-memory/paths")
const { Global } = await import("@opencode-ai/core/global")
const { coordinateNativeRoots, coordinateProfileWriters, profileScope, resolveProfileRoot } = await import(
  "@opencode-ai/core/kilocode/profile-maintenance"
)
const { closeProcessProfile } = await import("@opencode-ai/core/kilocode/process-profile")
const { install } = await import("../../../src/kilocode/memory/admission")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { ProfileWriterLive } = await import("../../../src/kilocode/migration/writer-live")
const { Effect } = await import("effect")
const ctx = { directory: workspace, worktree: workspace }
const namespace = MemoryPaths.root({ ctx, data: Global.Path.data })
await mkdir(namespace, { recursive: true })
const canonical = await realpath(namespace)
const files = MemoryPaths.files(canonical)
const results: string[] = []
const state = { token: undefined as string | undefined }
if (["cycle", "file", "recovery", "show-recovery", "prune", "purge", "concurrent", "queue-tamper"].includes(mode))
  await Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
if (mode === "recovery" || mode === "show-recovery") await writeFile(files.state, "{invalid-private-state")
if (mode === "prune")
  await MemoryFiles.writeSession(canonical, { sessionID: "ses_private", summary: "Private test summary", max: 10 })
if (mode === "stale") {
  await mkdir(path.join(canonical, ".lock"))
  const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(String(process.pid))"], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(code, 0)
  assert.equal(err, "")
  const pid = Number(out)
  assert(Number.isSafeInteger(pid) && pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  const owner = path.join(canonical, ".lock", "owner")
  state.token = `${pid}.1.private`
  await writeFile(owner, state.token)
  await utimes(owner, new Date(0), new Date(0))
}
if (mode === "failure") await mkdir(files.state)
const alias = path.join(root, "alias")
const outside = path.join(root, "outside")
if (mode === "alias" || mode === "rebind") {
  await mkdir(outside)
  await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir")
}
if (mode === "alias") {
  await writeFile(path.join(outside, "original.json"), "{}")
  await symlink(outside, files.state, process.platform === "win32" ? "junction" : "dir")
}
assert.equal(Effect.runSync(ProfileWriterLive.snapshot).registered.includes("profile.data.memory"), false)
assert.throws(() => ProfileWriterLive.admission("profile.data.memory"), /port is not installed/)
assert.equal(Effect.runSync(ProfileWriterLive.snapshot).registered.includes("profile.data.memory"), false)
install()
const admission = ProfileWriterLive.admission("profile.data.memory")
install()
assert.equal(ProfileWriterLive.admission("profile.data.memory"), admission)
assert.equal(
  Effect.runSync(ProfileWriterLive.snapshot).registered.filter((id) => id === "profile.data.memory").length,
  1,
)
results.push("preinstall-admission-refused", "actual-port-install-idempotent")
if (mode === "alias") {
  await assert.rejects(Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) }))
  assert.equal(await readFile(path.join(outside, "original.json"), "utf8"), "{}")
  await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
  results.push("actual-junction-target-refused", "outside-content-unchanged")
} else if (mode === "rebind") {
  const { Hash } = await import("@opencode-ai/core/util/hash")
  const joined = Promise.withResolvers<Promise<void>>()
  const data = await resolveProfileRoot({ kind: "json", path: Global.Path.data })
  const markers = path.join(path.dirname(data.path), ".raya-profile-locks", Hash.fast(data.id) + ".writers")
  await coordinateNativeRoots([{ kind: "json", path: canonical }], async () => {
    joined.resolve(assert.rejects(Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) }), /changed/))
    const end = Date.now() + 3000
    while (
      !(
        await readdir(markers).catch((err) => {
          if (err.code === "ENOENT") return []
          throw err
        })
      ).length
    ) {
      assert(Date.now() < end)
      await Bun.sleep(10)
    }
    assert(!path.relative(root, canonical).startsWith(".."))
    await rename(canonical, path.join(root, "retained-memory"))
    await symlink(outside, canonical, process.platform === "win32" ? "junction" : "dir")
  })
  await joined.promise
  assert.deepEqual(await readdir(outside), [])
  await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
  results.push("actual-canonical-junction-rebind-refused", "foreign-target-unmodified")
} else if (mode === "slots" || mode === "saturation" || mode === "churn" || mode === "bounded") {
  const { ProfileRoots } = await import("@opencode-ai/core/kilocode/profile-roots")
  const target = path.join(canonical, "project.md")
  const temporary = (slot: number) => path.join(canonical, `.project.md.memory-${slot}.tmp`)
  if (mode === "saturation") {
    for (let slot = 0; slot < 8; slot++) await writeFile(temporary(slot), `foreign-${slot}`, { flag: "wx" })
    await assert.rejects(MemoryFiles.writeSource(canonical, "project.md", "refused"), /eight temporary slots/)
    for (let slot = 0; slot < 8; slot++) assert.equal(await readFile(temporary(slot), "utf8"), `foreign-${slot}`)
    await assert.rejects(readFile(target), { code: "ENOENT" })
    await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
    results.push("all-eight-occupied-slots-preserved", "finite-saturation-refused")
  } else if (mode === "slots") {
    await writeFile(temporary(0), "foreign", { flag: "wx" })
    await MemoryFiles.writeSource(canonical, "project.md", "first")
    const before = ProfileRoots.snapshot().length
    await Promise.all(
      Array.from({ length: 24 }, (_, index) => MemoryFiles.writeSource(canonical, "project.md", `whole-${index}`)),
    )
    assert.match(await readFile(target, "utf8"), /^whole-(?:[0-9]|1[0-9]|2[0-3])\n$/)
    assert.equal(await readFile(temporary(0), "utf8"), "foreign")
    assert.equal(ProfileRoots.snapshot().length, before)
    assert.deepEqual(
      (await readdir(canonical)).filter((name) => name.endsWith(".tmp")),
      [path.basename(temporary(0))],
    )
    results.push("concurrent-complete-publications", "occupied-first-slot-preserved", "same-target-ack-growth-bounded")
  } else {
    await Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
    const before = ProfileRoots.snapshot().length
    for (let index = 0; index < 40; index++) {
      await MemoryFiles.writeSession(canonical, {
        sessionID: `ses_private_${index}`,
        summary: "Private test summary",
        max: 100,
        time: 1700000000000 + index,
      })
      await MemoryFiles.pruneSessions(canonical, 20)
    }
    const after = ProfileRoots.snapshot().length
    const retained = (await readdir(files.sessions)).filter((name) => name.endsWith(".md")).length
    const directory = path.join(files.sessions, ".raya-profile-locks")
    const controls = await Promise.all(
      (await readdir(directory)).map(async (name) => {
        const file = path.join(directory, name)
        const info = await lstat(file, { bigint: true })
        return {
          name,
          directory: info.isDirectory(),
          link: info.isSymbolicLink(),
          dev: String(info.dev),
          ino: String(info.ino),
          children: info.isDirectory() && !info.isSymbolicLink() ? await readdir(file) : undefined,
        }
      }),
    )
    const metadata = controls.length
    await writeFile(
      path.join(root, "churn.json"),
      JSON.stringify({ before, after, retained, metadata, controls, bounded: mode === "bounded" }),
      { flag: "wx" },
    )
    assert.equal(retained, 20)
    if (mode === "churn") assert(after > before + retained)
    if (mode === "bounded") {
      assert.equal(after, before)
      assert.deepEqual(
        controls.map((item) => ({
          name: item.name,
          directory: item.directory,
          link: item.link,
          children: item.children,
        })),
        [{ name: "covered.references", directory: true, link: false, children: [] }],
      )
      results.push("one-fixed-empty-reference-scaffold", "zero-historical-target-markers")
    }
    results.push(
      "actual-forty-session-writes-prune-twenty",
      mode === "bounded" ? "live-namespace-covered-ownership-bounded" : "historical-ownership-growth-still-unfinished",
    )
  }
} else if (mode === "queue-tamper") {
  const before = await readFile(files.state)
  const owner = path.join(canonical, ".lock", "owner")
  const saved = { token: "" }
  await assert.rejects(
    MemoryFiles.queue(canonical, async () => {
      saved.token = await readFile(owner, "utf8")
      await rename(owner, path.join(root, "original-owner.private"))
      await writeFile(owner, saved.token, { flag: "wx" })
      await MemoryFiles.purge(canonical)
    }),
  )
  assert.deepEqual(await readFile(files.state), before)
  assert.equal(await readFile(owner, "utf8"), saved.token)
  await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
  results.push("same-token-owner-identity-tamper-refused", "no-content-or-foreign-owner-removal")
} else if (mode === "heartbeat") {
  const owner = path.join(canonical, ".lock", "owner")
  const stamp = new Date(1000)
  const saved = { token: "" }
  await assert.rejects(
    MemoryFiles.queue(canonical, async () => {
      saved.token = await readFile(owner, "utf8")
      await rename(owner, path.join(root, "retained-owner.private"))
      await writeFile(owner, saved.token, { flag: "wx" })
      await utimes(owner, stamp, stamp)
      await Bun.sleep(10500)
      assert.equal((await stat(owner)).mtimeMs, stamp.getTime())
      assert.equal(await readFile(owner, "utf8"), saved.token)
    }),
  )
  assert.equal((await stat(owner)).mtimeMs, stamp.getTime())
  assert.equal(await readFile(owner, "utf8"), saved.token)
  await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
  results.push(
    "real-held-handle-heartbeat-replacement-refused",
    "foreign-owner-bytes-and-time-unchanged",
    "retirement-refused",
  )
} else if (mode === "failure") {
  await assert.rejects(Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) }), Error)
  await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
  await assert.rejects(KiloShutdown.run(), /Memory writer retirement failed/)
  await assert.rejects(Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) }), /retired/)
  results.push("real-filesystem-failure-retained", "retirement-refused", "late-refused")
} else if (mode === "stale") {
  await Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
  const { ProfileRoots } = await import("@opencode-ai/core/kilocode/profile-roots")
  const before = ProfileRoots.snapshot().length
  assert(state.token)
  for (let index = 0; index < 10; index++) {
    const owner = path.join(canonical, ".lock", "owner")
    await writeFile(owner, state.token, { flag: "wx" })
    await utimes(owner, new Date(0), new Date(0))
    await MemoryFiles.queue(canonical, () => Promise.resolve())
  }
  assert.equal(ProfileRoots.snapshot().length, before)
  await Memory.rebuild({ root: canonical })
  await assert.rejects(readFile(path.join(canonical, ".lock", "owner")), { code: "ENOENT" })
  results.push("actual-exited-owner-stale-recovery", "ten-recoveries-no-ack-growth", "repeated-queue-owner-released")
} else if (mode === "purged-reader") {
  await Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
  assert.equal((await Memory.purge({ root: canonical })).purged, true)
  assert.equal((await Memory.purge({ root: canonical })).purged, false)
  results.push("actual-hosted-purge-content", "repeat-purge-safe")
} else if (mode === "cycle") {
  await Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
  await Memory.rebuild({ root: canonical })
  assert.equal((await Memory.purge({ root: canonical })).purged, true)
  assert.equal((await Memory.purge({ root: canonical })).purged, false)
  await Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
  assert.equal((await MemoryFiles.readState(canonical)).enabled, true)
  assert((await stat(path.join(canonical, ".lock", ".raya-profile-locks"))).isDirectory())
  await assert.rejects(readFile(path.join(canonical, ".lock", "owner")), { code: "ENOENT" })
  results.push("enable-rebuild-purge-repeat-enable", "coordination-preserved-owner-released")
} else if (mode === "concurrent") {
  await Promise.all([
    Memory.configure({ root: canonical, settings: { verbose: true } }),
    Memory.configure({ root: canonical, settings: { autoConsolidate: false } }),
  ])
  const saved = await MemoryFiles.readState(canonical)
  assert.equal(saved.verbose, true)
  assert.equal(saved.autoConsolidate, false)
  results.push("real-concurrent-queue", "both-patches-retained")
} else {
  const selected =
    mode === "global"
      ? Global.Path.data
      : mode === "file" || mode === "recovery" || mode === "show-recovery"
        ? files.state
        : mode === "prune"
          ? path.join(files.sessions, (await readdir(files.sessions))[0])
          : canonical
  const before = await readFile(files.state).catch((err) => {
    if (err.code === "ENOENT") return null
    throw err
  })
  const joined = Promise.withResolvers<Promise<unknown>>()
  const body = async () => {
    const work =
      mode === "show-recovery"
        ? MemoryFiles.show(canonical)
        : mode === "recovery"
          ? MemoryFiles.readState(canonical)
          : mode === "prune"
            ? MemoryFiles.pruneSessions(canonical, 0)
            : mode === "purge"
              ? MemoryFiles.purge(canonical)
              : Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) })
    const handled = work.then(
      (value) => ({ value }),
      (err) => ({ err }),
    )
    joined.resolve(handled)
    await Bun.sleep(150)
    assert.equal(
      Effect.runSync(ProfileWriterLive.snapshot).active.find((item) => item.id === "profile.data.memory")?.count,
      1,
    )
    results.push("actual-outer-writer-registry-count-one")
    assert.deepEqual(
      await readFile(files.state).catch((err) => {
        if (err.code === "ENOENT") return null
        throw err
      }),
      before,
    )
    if (mode === "prune") assert((await stat(selected)).isFile())
    results.push("no-mutation-while-real-gate-held")
    if (mode === "retire") {
      const retired = KiloShutdown.run()
      await Promise.resolve()
      await assert.rejects(Memory.enable({ root: canonical, id: MemoryPaths.identity({ ctx }) }), /retired/)
      assert.equal(
        Effect.runSync(ProfileWriterLive.snapshot).active.find((item) => item.id === "profile.data.memory")?.count,
        1,
      )
      let done = false
      void retired.then(
        () => {
          done = true
        },
        () => {
          done = true
        },
      )
      await Bun.sleep(25)
      assert.equal(done, false)
      results.push("accepted-drain-not-finished-before-gate-release", "late-refused")
    }
  }
  if (mode === "global") {
    const scope = await profileScope({
      data: Global.Path.data,
      channel: "latest",
      disabled: true,
      storage: Global.Path.data,
    })
    await coordinateProfileWriters(scope, "cooperative-maintenance", body)
    results.push("global-cooperative-writer-gate-not-native-closure")
  } else await coordinateNativeRoots([{ kind: "json", path: selected }], body)
  const outcome = await joined.promise
  if (outcome && typeof outcome === "object" && "err" in outcome) throw outcome.err
  if (mode === "prune") await assert.rejects(readFile(selected), { code: "ENOENT" })
  if (mode === "recovery" || mode === "show-recovery") {
    assert.equal((await MemoryFiles.readState(canonical)).enabled, false)
    assert((await readdir(canonical)).some((name) => name.startsWith("state.json.bad-")))
  }
  results.push("real-operation-finished-after-release")
}
if (!["failure", "alias", "rebind", "heartbeat", "saturation", "queue-tamper"].includes(mode)) await KiloShutdown.run()
assert.equal(
  Effect.runSync(ProfileWriterLive.snapshot).active.some((item) => item.id === "profile.data.memory"),
  false,
)
results.push("actual-writer-registry-settled-zero")
await closeProcessProfile()
if (mode === "purged-reader" || mode === "cycle") {
  const { memories } = await import("../../../src/kilocode/migration/profile-memory")
  const values = await memories(path.join(Global.Path.data, "memory"))
  assert.equal(values.length, mode === "cycle" ? 1 : 0)
  results.push("actual-retired-metadata-reader")
}
console.log(JSON.stringify({ passed: true, mode, root, namespace: canonical, results, models: 0 }))
