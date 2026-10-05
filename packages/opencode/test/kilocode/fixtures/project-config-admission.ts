import assert from "node:assert/strict"
import path from "node:path"
import { lstat, mkdir, readFile, readdir, rename, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
const [input, mode] = process.argv.slice(2)
const root = path.resolve(input)
const workspace = path.join(root, "workspace", ...(mode === "scaffold-order" ? ["nested"] : []))
const dir = path.join(workspace, ".kilo")
const file = path.join(dir, "kilo.jsonc")
const scaffold = mode.startsWith("scaffold")
await mkdir(scaffold ? workspace : dir, { recursive: true })
const alternate = path.join(workspace, ".kilocode")
if (mode === "scaffold-rebind") await mkdir(alternate)
if (mode === "scaffold-order") {
  const child = Bun.spawn(["git", "init", path.dirname(workspace)], {
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  assert.equal(await child.exited, 0, await new Response(child.stderr).text())
  await mkdir(path.join(path.dirname(workspace), ".kilocode"))
}
for (const key of Object.keys(process.env)) if (/^(RAYA|KILO|OPENCODE|OTEL)_/.test(key)) delete process.env[key]
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  KILO_TEST_HOME: path.join(root, "home"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  RAYA_DB: path.join(root, "data/kilo/raya.db"),
  KILO_DB: path.join(root, "data/kilo/raya.db"),
  KILO_AUTH_CONTENT: "{}",
  RAYA_AUTH_CONTENT: "{}",
  KILO_DISABLE_MODELS_FETCH: "1",
  RAYA_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
  KILO_DISABLE_AUTOUPDATE: "1",
})
await mkdir(path.join(root, "config/kilo"), { recursive: true })
await writeFile(
  path.join(root, "config/kilo/kilo.json"),
  JSON.stringify({
    $schema: "https://app.kilo.ai/config.json",
    enabled_providers: [],
    permission: "deny",
    formatter: false,
    lsp: false,
  }),
)
const before =
  "// untouched café 日本語\n" +
  JSON.stringify(
    { $schema: "https://app.kilo.ai/config.json", model: "synthetic/original", small_model: "synthetic/retained" },
    null,
    2,
  )
const missing = path.join(root, "uncreated.json")
const alias =
  mode === "dangling"
    ? await symlink(missing, file, "file").then(
        () => "file",
        async (err) => {
          if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(err.code)) throw err
          await symlink(missing, file, "junction")
          return "junction"
        },
      )
    : undefined
if (!alias && !scaffold) await writeFile(file, before)
const { Effect } = await import("effect")
const { Server } = await import("../../../src/server/server")
const { AppRuntime } = await import("../../../src/effect/app-runtime")
const { InstanceStore } = await import("../../../src/project/instance-store")
const { Config } = await import("../../../src/config/config")
const { KilocodeConfigOverlay } = await import("../../../src/kilocode/config/overlay")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { finish } = await import("../../../src/kilocode/cli/finish")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { coordinateProfileWriters, profileScope, resolveProfileRoot } = await import(
  "@opencode-ai/core/kilocode/profile-maintenance"
)
const { Flock } = await import("@opencode-ai/core/util/flock")
const { processProfileSnapshot } = await import("@opencode-ai/core/kilocode/process-profile")
const { participantScopes } = await import("../../../src/kilocode/cli/profile-participants")
const { ConfigIntent } = await import("@opencode-ai/core/kilocode/config-intent")
const { Hash } = await import("@opencode-ai/core/util/hash")
const app = Server.Default().app
const headers = { "content-type": "application/json", "x-kilo-directory": workspace }
const route = `/config?directory=${encodeURIComponent(workspace)}`
const save = (cfg: object) => app.request(route, { method: "PATCH", headers, body: JSON.stringify(cfg) })
const update = (cfg: ReturnType<typeof KilocodeConfigOverlay.patch>) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const instances = yield* InstanceStore.Service
      yield* instances.provide(
        { directory: workspace },
        Config.Service.use((service) => service.update(cfg)),
      )
    }),
  )
const results: string[] = []
let passed = false
assert.equal((await app.request(route, { headers })).status, 200)
try {
  if (mode === "scaffold") {
    await assert.rejects(lstat(dir), { code: "ENOENT" })
    assert.equal((await save({ snapshot: false })).status, 200)
    assert.equal(JSON.parse(await readFile(file, "utf8")).snapshot, false)
    const effective = await (await app.request(route, { headers })).json()
    assert.equal(effective.snapshot, false)
    const original = await readFile(file)
    assert.equal((await save({ small_model: "synthetic/scaffold" })).status, 200)
    assert.equal((await app.request(route, { headers })).status, 200)
    await KiloShutdown.run()
    await ConfigIntent.retire()
    const { namespaceScopes } = await import("../../../src/kilocode/migration/profile-scope")
    const { ProfileRoots } = await import("@opencode-ai/core/kilocode/profile-roots")
    const { LineageIntent } = await import("@opencode-ai/core/kilocode/config-intent-schema")
    const selected = await namespaceScopes(participantScopes(true), ProfileRoots.snapshot(), {
      version: 1,
      directories: [root],
      files: [],
    })
    const documents = selected.configs.flatMap((graph) =>
      LineageIntent.parse(graph).documents.filter((doc) => path.normalize(doc.path) === path.normalize(file)),
    )
    const bytes = await readFile(file)
    const info = await lstat(file, { bigint: true })
    assert(documents.length > 0)
    assert(
      documents.every(
        (doc) =>
          doc.digest === createHash("sha256").update(bytes).digest("hex") &&
          doc.bytes === bytes.length &&
          doc.identity.dev === String(info.dev) &&
          doc.identity.ino === String(info.ino),
      ),
    )
    assert(
      documents.some((doc) =>
        doc.history?.some(
          (old) => old.digest === createHash("sha256").update(original).digest("hex") && old.bytes === original.length,
        ),
      ),
    )
    results.push(
      "genuine-missing-project-parent-created",
      "actual-config-write-and-reload",
      "exact-current-and-own-history-lineage",
    )
  } else if (mode === "scaffold-order") {
    const ancestor = path.dirname(workspace)
    const file = path.join(ancestor, ".kilocode", "kilo.jsonc")
    const admitted = await resolveProfileRoot({ kind: "json", path: file })
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const maintenance = Flock.withLock(
      admitted.id,
      async () => {
        ready.resolve()
        await release.promise
      },
      { dir: path.join(path.dirname(file), ".raya-profile-locks") },
    )
    await ready.promise
    const saving = Promise.resolve(save({ snapshot: false }))
    const marker = (file: string) =>
      path.join(
        path.dirname(file),
        ".raya-profile-locks",
        Hash.fast(`raya.profile.json:${process.platform === "win32" ? file.toLowerCase() : file}`) + ".writers",
      )
    const entries = (file: string) =>
      readdir(marker(file)).catch((err) => {
        if (err.code === "ENOENT") return []
        throw err
      })
    const limit = Date.now() + 5000
    while (!(await entries(ancestor)).length) {
      assert(Date.now() < limit, "Worktree namespace admission deadline")
      await Bun.sleep(10)
    }
    const end = Date.now() + 150
    do {
      assert.deepEqual(await entries(workspace), [])
      await assert.rejects(lstat(dir), { code: "ENOENT" })
      await Bun.sleep(10)
    } while (Date.now() < end)
    release.resolve()
    await maintenance
    assert.equal((await saving).status, 200)
    assert.equal(JSON.parse(await readFile(path.join(dir, "kilo.jsonc"), "utf8")).snapshot, false)
    await KiloShutdown.run()
    const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
    await InstanceRuntime.disposeAllInstances()
    results.push("genuine-ancestor-file-gate-precedes-nested-namespace", "sorted-maintenance-order-preserved")
  } else if (mode === "scaffold-foreign" || mode === "scaffold-rebind") {
    const selected = mode === "scaffold-foreign" ? dir : path.join(alternate, "kilo.jsonc")
    const admitted = await resolveProfileRoot({ kind: "json", path: selected })
    // Raw exact gate setup must not create the missing config directory.
    const locks = path.join(path.dirname(admitted.path), ".raya-profile-locks")
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const maintenance = Flock.withLock(
      admitted.id,
      async () => {
        ready.resolve()
        await release.promise
      },
      { dir: locks },
    )
    await ready.promise
    await assert.rejects(lstat(dir), { code: "ENOENT" })
    const state = { settled: false }
    const saving = Promise.resolve(save({ snapshot: false })).then((response) => {
      state.settled = true
      return response
    })
    const key = `raya.profile.json:${process.platform === "win32" ? workspace.toLowerCase() : workspace}`
    const writers = path.join(root, ".raya-profile-locks", Hash.fast(key) + ".writers")
    const limit = Date.now() + 5000
    while (
      !(
        await readdir(writers).catch((err) => {
          if (err.code === "ENOENT") return []
          throw err
        })
      ).length
    ) {
      assert(Date.now() < limit, "Selected namespace admission marker deadline")
      await Bun.sleep(10)
    }
    if (mode === "scaffold-foreign") {
      await assert.rejects(lstat(dir), { code: "ENOENT" })
      await mkdir(dir)
    } else {
      while (
        !(await lstat(dir).then(
          () => true,
          (err) => {
            if (err.code === "ENOENT") return false
            throw err
          },
        ))
      ) {
        assert(Date.now() < limit, "Owned scaffold creation deadline")
        await Bun.sleep(10)
      }
      const admitted = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json"].map((name) => {
        const file = path.join(dir, name)
        const key = `raya.profile.json:${process.platform === "win32" ? file.toLowerCase() : file}`
        return path.join(dir, ".raya-profile-locks", Hash.fast(key) + ".writers")
      })
      while (
        !(
          await Promise.all(
            admitted.map((file) =>
              readdir(file).catch((err) => {
                if (err.code === "ENOENT") return []
                throw err
              }),
            ),
          )
        ).every((files) => files.length > 0)
      ) {
        assert(Date.now() < limit, "All exact primary admissions before compatibility gate deadline")
        await Bun.sleep(10)
      }
      const own = await lstat(dir, { bigint: true })
      assert(own.isDirectory() && !own.isSymbolicLink())
      assert.equal(state.settled, false)
      assert.equal(await Bun.file(file).exists(), false)
      await rename(dir, path.join(workspace, "original-scaffold"))
      await mkdir(dir)
      const replacement = await lstat(dir, { bigint: true })
      assert(own.dev !== replacement.dev || own.ino !== replacement.ino)
    }
    const foreign = '// foreign original\n{"small_model":"synthetic/foreign"}'
    await writeFile(file, foreign)
    release.resolve()
    await maintenance
    assert.equal((await saving).status, 500)
    assert.equal(await readFile(file, "utf8"), foreign)
    await assert.rejects(KiloShutdown.run(), /Project config retirement failed/)
    results.push(
      "actual-missing-parent-foreign-generation-refused",
      "foreign-bytes-preserved",
      "sticky-retirement-refusal",
    )
  } else if (mode === "dangling") {
    assert.equal((await save({ model: "synthetic/owned" })).status, 500)
    assert((await lstat(file)).isSymbolicLink())
    assert.equal(await Bun.file(missing).exists(), false)
    await assert.rejects(KiloShutdown.run(), /Project config retirement failed/)
    results.push(`dangling-${alias}-refused`, "original-link-preserved", "target-not-created")
  } else if (mode === "foreign") {
    const foreign = before.replace("synthetic/original", "synthetic/foreign")
    await writeFile(file, foreign)
    assert.equal((await save({ model: "synthetic/owned" })).status, 500)
    assert.equal(await readFile(file, "utf8"), foreign)
    await assert.rejects(KiloShutdown.run(), /Project config retirement failed/)
    await ConfigIntent.retire()
    assert.throws(() => participantScopes(true), /Source export lacks confirmed configuration/)
    results.push("foreign-origin-refused-before-write", "foreign-bytes-preserved", "sticky-retirement-failure")
  } else if (mode === "unset") {
    const lower = path.join(dir, "kilo.json")
    await writeFile(lower, JSON.stringify({ model: "synthetic/lower", small_model: "synthetic/retained" }))
    await app.request(route, { headers })
    await update(KilocodeConfigOverlay.patch({ scope: "project", unset: [["model"]] }))
    const primary = await readFile(file, "utf8")
    const secondary = JSON.parse(await readFile(lower, "utf8"))
    assert(primary.startsWith("// untouched café 日本語\n"))
    assert(!primary.includes('"model":'))
    assert.equal(secondary.model, undefined)
    assert.equal(secondary.small_model, "synthetic/retained")
    const effective = await (await app.request(route, { headers })).json()
    assert.equal(effective.model, undefined)
    assert.equal(effective.small_model, "synthetic/retained")
    results.push("actual-service-unset-propagates-precedence", "both-original-fields-preserved", "comments-preserved")
  } else {
    const selected = mode === "parent" || mode === "rebind" ? dir : mode === "file" ? file : workspace
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const body = async () => {
      ready.resolve()
      await release.promise
    }
    const admitted = await resolveProfileRoot({ kind: "json", path: selected })
    const maintenance =
      mode === "file"
        ? Flock.withLock(admitted.id, body, { dir: path.join(path.dirname(admitted.path), ".raya-profile-locks") })
        : coordinateProfileWriters(
            await profileScope({
              data: root,
              channel: "latest",
              disabled: false,
              override: path.join(root, "maintenance.db"),
              storage: selected,
            }),
            "cooperative-maintenance",
            body,
          )
    await ready.promise
    const state = { saved: false, retired: false }
    const requests =
      mode === "rebind"
        ? Promise.all(
            [update({ model: "synthetic/after" })].map((task) =>
              task.then(
                () => false,
                () => true,
              ),
            ),
          ).then((values) => values.every(Boolean))
        : Promise.all([save({ model: "synthetic/after" }), save({ small_model: "synthetic/small" })]).then(
            (responses) => responses.every((response) => response.status === 200),
          )
    const saved = requests.then(() => {
      state.saved = true
    })
    if (mode === "rebind") {
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
      const foreign = path.join(root, "foreign")
      await mkdir(foreign)
      await writeFile(path.join(foreign, "kilo.jsonc"), before)
      await rename(dir, path.join(workspace, "original"))
      await symlink(foreign, dir, process.platform === "win32" ? "junction" : "dir")
      release.resolve()
      await maintenance
      assert(await requests)
      assert.equal(await readFile(path.join(foreign, "kilo.jsonc"), "utf8"), before)
      await assert.rejects(KiloShutdown.run(), /Project config retirement failed/)
      assert(!processProfileSnapshot().roots.includes(await realpath(foreign)))
      await rm(dir)
      await rename(path.join(workspace, "original"), dir)
      results.push("real-directory-generation-rebind-refused", "no-foreign-write-or-registration")
    } else {
      await Bun.sleep(40)
      const retired = KiloShutdown.run().then(() => {
        state.retired = true
      })
      const end = Date.now() + 150
      do {
        assert.equal(await readFile(file, "utf8"), before)
        assert.equal(state.saved, false)
        assert.equal(state.retired, false)
        await Bun.sleep(10)
      } while (Date.now() < end)
      release.resolve()
      await maintenance
      assert(await requests)
      await Promise.all([saved, retired])
      assert.equal((await save({ model: "synthetic/late" })).status, 500)
      const current = await readFile(file, "utf8")
      assert(current.startsWith("// untouched café 日本語\n"))
      assert(current.includes("synthetic/after") && current.includes("synthetic/small"))
      for (const selected of [workspace, dir, file])
        assert(processProfileSnapshot().roots.includes(await realpath(selected)))
      results.push(
        "actual-cooperative-gate-held",
        "accepted-rmw-and-publication-drained",
        "late-refused",
        "concurrent-patches-retained",
      )
    }
  }
  passed = true
} catch (err) {
  process.exitCode = 1
  console.error(err)
} finally {
  if (!passed) process.exitCode = 1
  await writeFile(
    path.join(root, "receipt.json"),
    JSON.stringify({ mode, passed, results, originalSHA: createHash("sha256").update(before).digest("hex") }),
    { flag: "wx" },
  )
  console.log(JSON.stringify({ mode, passed, results }))
  await finish([
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
    },
  ]).catch((err) => {
    if (mode !== "foreign" && mode !== "rebind" && !mode.startsWith("scaffold-")) throw err
    results.push("expected-failed-retirement-preserved")
  })
}
