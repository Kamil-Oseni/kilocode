import { expect, test } from "bun:test"
import { build } from "esbuild"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, basename, sep } from "node:path"
import { parse } from "../../src/home-assistant/config"
import { Settings } from "../../src/home-assistant/settings"
import { retire } from "../../src/home-assistant/retirement"

const cfg = { version: 1, origin: "http://192.168.100.160", entities: ["light.bedroom_left"], modes: [] }
const key = "raya.homeAssistant.settings"

async function clean(root: string) {
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith("raya-ha-setup-"))
    throw new Error("Fixture cleanup containment refused")
  await rm(target, { recursive: true, force: true })
}

test("configuration accepts only canonical private origins and explicit entities", () => {
  expect(parse(cfg).origin).toBe(cfg.origin)
  for (const origin of [
    "http://localhost",
    "http://8.8.8.8",
    "http://127.1",
    "http://0177.0.0.1",
    "http://0x7f000001",
    "http://192.168.100.160/path",
    "http://192.168.100.160?token=x",
    "http://user@192.168.100.160",
    "http://192.168.100.160:65536",
  ])
    expect(() => parse({ ...cfg, origin })).toThrow()
  expect(() => parse({ ...cfg, entities: ["light.bedroom_left", "light.bedroom_left"] })).toThrow()
  expect(() => parse({ ...cfg, entities: ["switch.anything"] })).toThrow()
  expect(() => parse({ ...cfg, modes: [{ name: "sleep", entity: "scene.sleep_mode", stop: true }] })).toThrow()
  expect(() => parse({ ...cfg, modes: [{ name: "wake", entity: "script.wake_mode_sunrise", extra: true }] })).toThrow()
})

test("file-backed publication keeps credentials private and rolls back failed replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-ha-setup-"))
  const values = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const failure = new Error("Synthetic publication failure")
  const cleanup = new Error("Synthetic cleanup failure")
  const state = { fail: false, cleanup: false, reads: 0 }
  const settings = new Settings(
    {
      get<T>(name: string) {
        return values.get(name) as T | undefined
      },
      async update(name, value) {
        if (state.fail) throw failure
        await writeFile(join(root, "public.json"), JSON.stringify(value))
        values.set(name, value)
      },
    },
    {
      async get(name) {
        state.reads++
        return secrets.get(name)
      },
      async store(name, value) {
        secrets.set(name, value)
      },
      delete(name) {
        if (state.cleanup) throw cleanup
        secrets.delete(name)
        return Promise.resolve()
      },
    },
  )
  try {
    await settings.save(cfg, "synthetic-first-token")
    const prior = values.get(key)
    expect(await settings.load()).toEqual({ config: parse(cfg), token: "synthetic-first-token" })
    expect(await readFile(join(root, "public.json"), "utf8")).not.toContain("synthetic-first-token")
    state.fail = true
    await expect(settings.save(cfg, "synthetic-second-token")).rejects.toBe(failure)
    expect(values.get(key)).toBe(prior)
    expect([...secrets.values()]).toEqual(["synthetic-first-token"])
    state.cleanup = true
    const err = await settings.save(cfg, "synthetic-third-token").catch((err) => err)
    expect(err).toBeInstanceOf(AggregateError)
    expect(err.errors).toEqual([failure, cleanup])
    values.set(key, { config: cfg, credential: "arbitrary" })
    const reads = state.reads
    await expect(settings.load()).rejects.toThrow("reference refused")
    expect(state.reads).toBe(reads)
  } finally {
    await clean(root)
  }
})

test("standalone Node bundle exercises masked native command and original shutdown joins", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-ha-setup-"))
  try {
    const output = join(root, "setup.cjs")
    await build({
      entryPoints: [resolve("src/home-assistant/setup.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["vscode"],
      logLevel: "silent",
    })
    for (const scenario of ["normal", "held-store", "closed-input"]) {
      const child = Bun.spawn(["node", resolve("tests/fixtures/home-assistant-setup.cjs"), output, root, scenario], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(JSON.parse(stdout)).toEqual({ passed: true, scenario, masked: true, serviceCalls: 0 })
    }
  } finally {
    await clean(root)
  }
}, 30000)

test("required retirement fences immediately and joins every failure before final cleanup", async () => {
  const events: string[] = []
  const failure = new Error("Synthetic required failure")
  const prior = new Error("Synthetic prior disposal failure")
  const final = new Error("Synthetic connection disposal failure")
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const job = retire(
    () => {
      events.push("fenced")
      return gate.then(() => {
        throw failure
      })
    },
    async () => {
      events.push("providers")
      throw prior
    },
    () => {
      events.push("connection")
      throw final
    },
  )
  const observed = job.catch((err) => err)
  expect(events).toEqual(["fenced", "providers"])
  await Promise.resolve()
  expect(events).not.toContain("connection")
  finish()
  const error = await observed
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors).toEqual([failure, prior, final])
  expect(events).toEqual(["fenced", "providers", "connection"])
})
