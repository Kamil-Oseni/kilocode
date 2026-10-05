import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import z from "zod"

async function wait(file: string, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return JSON.parse(await readFile(file, "utf8")) as unknown
    await Bun.sleep(50)
  }
  throw new Error(`Source fixture deadline; diagnostics retained at ${path.dirname(file)}`)
}

function environment(root: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    KILO_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    RAYA_DB: path.join(root, "unused.db"),
    KILO_DB: path.join(root, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
  }
  for (const name of Object.keys(env))
    if (name.startsWith("OTEL_") || /(API_KEY|TOKEN|SECRET)$/.test(name)) delete env[name]
  return env
}

async function run(mode: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-handoff-test-"))
  await mkdir(path.join(root, "home"))
  const env = environment(root)
  const source = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures/source-host-parent.ts"), root, mode],
    { env, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const output = new Response(source.stdout).text()
  const errors = new Response(source.stderr).text().then(async (text) => {
    await writeFile(path.join(root, "stderr.log"), text)
    return text
  })
  const joins: Promise<unknown>[] = []
  try {
    const ticket = z
      .object({
        control: z.string(),
        controller: z.number().int().positive(),
        birth: z.string(),
        generation: z.string().uuid(),
        id: z.string().uuid(),
      })
      .strict()
      .parse(await wait(path.join(root, "prepared.json")))
    const watcher = path.join(root, "watcher")
    await mkdir(watcher)
    const monitor = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures/source-host-observer.ts"),
        String(ticket.controller),
        ticket.birth,
        path.join(watcher, "ready.json"),
      ],
      {
        env: {
          ...env,
          HOME: watcher,
          USERPROFILE: watcher,
          KILO_TEST_HOME: watcher,
          XDG_DATA_HOME: path.join(watcher, "data"),
          XDG_CONFIG_HOME: path.join(watcher, "config"),
          XDG_STATE_HOME: path.join(watcher, "state"),
          XDG_CACHE_HOME: path.join(watcher, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const monitored = new Response(monitor.stdout).text()
    const failures = new Response(monitor.stderr).text()
    joins.push(monitor.exited, monitored, failures)
    const deadline = Date.now() + 15_000
    while (!(await Bun.file(path.join(watcher, "ready.json")).exists())) {
      if (Date.now() > deadline) throw new Error(`Native controller watcher not ready; retained ${root}`)
      await Bun.sleep(50)
    }
    await wait(path.join(root, "held.json"))
    expect(await Bun.file(path.join(ticket.control, "result.json")).exists()).toBe(false)
    expect(() => process.kill(source.pid, 0)).not.toThrow()
    await writeFile(path.join(root, "continue"), "release")
    const code = await source.exited
    await output
    await writeFile(path.join(root, "stderr.log"), await errors)
    expect(code).toBe(mode === "failed-exit" ? 1 : 0)
    expect(() => process.kill(source.pid, 0)).toThrow()
    const result = z
      .object({
        status: z.enum(["observed", "refused"]),
        generation: z.string().uuid(),
        id: z.string().uuid(),
        completeProfileCoverage: z.literal(false),
        portableCaptureAuthorized: z.literal(false),
      })
      .parse(await wait(path.join(ticket.control, "result.json")))
    expect(await monitor.exited).toBe(0)
    expect(JSON.parse(await monitored).code).toBe(mode === "success" || mode === "conflict" ? 0 : 1)
    expect(await failures).toBe("")
    expect(result.generation).toBe(ticket.generation)
    expect(result.id).toBe(ticket.id)
    expect(result.completeProfileCoverage).toBe(false)
    expect(result.portableCaptureAuthorized).toBe(false)
    if (mode === "conflict") expect(await wait(path.join(root, "conflict.json"))).toEqual({ refused: true })
    const db = new Database(path.join(root, "source.db"), { readonly: true })
    try {
      expect(db.query("SELECT value FROM durable").all()).toEqual([
        { value: "initial" },
        { value: "finalizer-persisted" },
      ])
    } finally {
      db.close()
    }
    expect(() => process.kill(ticket.controller, 0)).toThrow()
    expect(() => process.kill(monitor.pid, 0)).toThrow()
    return result
  } finally {
    await writeFile(path.join(root, "continue"), "release")
    await source.exited
    await Promise.allSettled([output, errors, ...joins])
  }
}

test("native successor READY precedes held actual finalizer, source exit precedes all-root gates", async () => {
  expect((await run("success")).status).toBe("observed")
}, 120_000)

for (const mode of ["failed-exit", "wrong-ack", "missing-ack"])
  test(`native source handoff refuses ${mode}`, async () => {
    expect((await run(mode)).status).toBe("refused")
  }, 120_000)

test("source prepare joins exact repetition and refuses a different trusted pin", async () => {
  expect((await run("conflict")).status).toBe("observed")
}, 120_000)

for (const mode of ["wrong-pin", "bad-command"])
  test(`source handoff refuses ${mode} before launching successor`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-refusal-test-"))
    await mkdir(path.join(root, "home"))
    await writeFile(path.join(root, "continue"), "release")
    const source = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/source-host-parent.ts"), root, mode],
      {
        env: environment(root),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const output = new Response(source.stdout).text()
    const errors = new Response(source.stderr).text()
    expect(await source.exited).toBe(1)
    await writeFile(path.join(root, "stderr.log"), await errors)
    expect(await output).toBe("")
    const failure = z
      .object({ message: z.string() })
      .strict()
      .parse(await wait(path.join(root, "failure.json")))
    expect(failure.message).toMatch(mode === "wrong-pin" ? /trusted pinned identity/ : /successor executable/)
    expect(await Bun.file(path.join(root, "prepared.json")).exists()).toBe(false)
    expect(() => process.kill(source.pid, 0)).toThrow()
  }, 120_000)
