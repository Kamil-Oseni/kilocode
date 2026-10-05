import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Fiber } from "effect"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publications } from "../../src/kilocode/credential-publication"
import { ProfileRoots } from "../../src/kilocode/profile-roots"

test("failed actual mirror retains nonsecret intent, SQL commit and sticky raw failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-credential-failure-"))
  const file = path.join(dir, "auth.json")
  const owner = publications(() => undefined)
  const db = new Database(path.join(dir, "test.db"))
  db.exec("CREATE TABLE value (data TEXT)")
  await mkdir(file)
  try {
    await expect(
      Effect.runPromise(
        owner.run(file, (channel) =>
          Effect.gen(function* () {
            yield* channel.begin
            yield* Effect.sync(() => db.exec("INSERT INTO value VALUES ('synthetic')"))
            yield* channel.write({ synthetic: { type: "api", key: "test-only-value" } })
            yield* channel.clear
          }),
        ),
      ),
    ).rejects.toThrow("Credential atomic publication failed")
    expect(db.query("SELECT COUNT(*) count FROM value").get()).toEqual({ count: 1 })
    const intent = JSON.parse(await readFile(`${file}.raya-intent.json`, "utf8"))
    expect(Object.keys(intent).sort()).toEqual(["format", "id", "version"])
    expect(JSON.stringify(intent)).not.toContain("test-only-value")
    expect(ProfileRoots.snapshot()).toContainEqual({ kind: "json", path: `${file}.raya-intent.json` })
    await expect(Effect.runPromise(owner.run(file, () => Effect.die("body must not run")))).rejects.toThrow(
      "retained intent",
    )
    const one = owner.retire()
    expect(owner.retire()).toBe(one)
    await expect(one).rejects.toThrow("retirement failed")
    await expect(Effect.runPromise(owner.run(file, () => Effect.void))).rejects.toThrow("admission is closed")
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("cancellation and retirement join accepted body before releasing actual publication lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-credential-held-"))
  const file = path.join(dir, "auth.json")
  const owner = publications(() => undefined)
  const other = publications(() => undefined)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const waited = Promise.withResolvers<void>()
  const fiber = Effect.runFork(
    owner.run(file, (channel) =>
      Effect.gen(function* () {
        yield* channel.begin
        yield* Effect.promise(() => {
          entered.resolve()
          return release.promise
        })
        yield* channel.write({ first: "synthetic" })
        yield* channel.clear
      }),
    ),
  )
  await entered.promise
  const stop = Effect.runPromise(Fiber.interrupt(fiber))
  const retiring = owner.retire()
  let settled = false
  void retiring.then(() => {
    settled = true
  })
  const queued = Effect.runPromise(
    other.run(file, (channel) =>
      Effect.gen(function* () {
        waited.resolve()
        const value = JSON.parse(yield* Effect.promise(() => readFile(channel.file, "utf8")))
        yield* channel.write({ ...value, second: "synthetic" })
      }),
    ),
  )
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await stop
  await retiring
  await queued
  await waited.promise
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ first: "synthetic", second: "synthetic" })
  expect(await Bun.file(`${file}.raya-intent.json`).exists()).toBe(false)
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
  await other.retire()
  await rm(dir, { recursive: true, force: true })
})

test("any uncertain intent refuses body before SQL or mirror effects", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-credential-intent-"))
  const file = path.join(dir, "auth.json")
  await writeFile(file, JSON.stringify({ stale: "synthetic" }))
  await writeFile(`${file}.raya-intent.json`, "{")
  const owner = publications(() => undefined)
  let called = false
  try {
    await expect(
      Effect.runPromise(
        owner.run(file, () =>
          Effect.sync(() => {
            called = true
          }),
        ),
      ),
    ).rejects.toThrow("retained intent")
    expect(called).toBe(false)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ stale: "synthetic" })
    expect(await readFile(`${file}.raya-intent.json`, "utf8")).toBe("{")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function child(mode: string, dir: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_TEST_HOME: dir,
    XDG_DATA_HOME: path.join(dir, "data"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  }
  delete env.KILO_AUTH_CONTENT
  delete env.RAYA_AUTH_CONTENT
  return Bun.spawn(
    [
      process.execPath,
      mode === "auth"
        ? path.join(import.meta.dir, "../../../opencode/test/kilocode/fixture/credential-publication.ts")
        : path.join(import.meta.dir, "fixture/credential-publication.ts"),
      mode,
      dir,
    ],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
}

test("independent actual Core and OpenCode publishers preserve both unrelated credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-credential-peers-"))
  const hosts = [child("core", dir), child("auth", dir)]
  const logs = hosts.map((host) => new Response(host.stderr).text())
  const timer = setTimeout(
    () =>
      hosts.forEach((host) => {
        if (host.exitCode === null) host.kill()
      }),
    20_000,
  )
  try {
    const codes = await Promise.all(hosts.map((host) => host.exited))
    const diagnostics = await Promise.all(logs)
    expect(codes, diagnostics.join("\n")).toEqual([0, 0])
    const mirror = JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8"))
    expect(mirror).toEqual({
      core: { type: "api", key: "synthetic-core" },
      external: { type: "api", key: "synthetic-external" },
    })
    expect(await Bun.file(path.join(dir, "auth.json.raya-intent.json")).exists()).toBe(false)
  } finally {
    clearTimeout(timer)
    for (const host of hosts) {
      if (host.exitCode === null) host.kill()
      await host.exited
    }
    await rm(dir, { recursive: true, force: true })
  }
}, 25_000)

test("actual crash after SQL commit refuses startup reimport of the stale mirror", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-credential-crash-"))
  const file = path.join(dir, "auth.json")
  await writeFile(file, JSON.stringify({ crash: { type: "api", key: "synthetic-old" } }))
  const host = child("crash", dir)
  const stderr = new Response(host.stderr).text()
  const timer = setTimeout(() => {
    if (host.exitCode === null) host.kill()
  }, 20_000)
  try {
    const reader = host.stdout.getReader()
    let output = ""
    while (!output.includes("COMMITTED")) {
      const result = await reader.read()
      if (result.done) throw new Error("Crash fixture did not commit before exit: " + (await stderr))
      output += new TextDecoder().decode(result.value)
    }
    host.kill()
    await host.exited
    await reader.cancel()
    const before = new Database(path.join(dir, "credentials.db"), { readonly: true })
    const value = before.query("SELECT value FROM credential WHERE id='cred_crash'").get()
    before.close()
    const importer = child("import", dir)
    const logs = new Response(importer.stderr).text()
    expect(await importer.exited, await logs).toBe(0)
    expect(JSON.parse(await new Response(importer.stdout).text())).toEqual({ imported: false })
    const after = new Database(path.join(dir, "credentials.db"), { readonly: true })
    expect(after.query("SELECT value FROM credential WHERE id='cred_crash'").get()).toEqual(value)
    after.close()
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ crash: { type: "api", key: "synthetic-old" } })
    expect(await Bun.file(`${file}.raya-intent.json`).exists()).toBe(true)
  } finally {
    clearTimeout(timer)
    if (host.exitCode === null) host.kill()
    await host.exited
    await rm(dir, { recursive: true, force: true })
  }
}, 25_000)
