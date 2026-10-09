import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { readFile, writeFile, rm, readdir } from "node:fs/promises"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import { command } from "../../src/second-brain/control/command"
import { sha } from "../../src/second-brain/control/frames"

async function fixture(hook?: (key: string, value: unknown) => Promise<void>) {
  const producer = await command(
    process.execPath,
    [path.resolve("tests/unit/fixtures/committed-capture-producer.ts")],
    {
      cwd: process.cwd(),
    },
  )
  const value = JSON.parse(producer.stdout) as {
    root: string
    notes: string
    file: string
    turn: { id: string }
    producer: { code: number; stdoutEOF: boolean; stderrEOF: boolean }
  }
  expect(producer.receipt.code).toBe(0)
  expect(value.producer).toMatchObject({ code: 0, stdoutEOF: true, stderrEOF: true })
  const storage = {
    get<T>(key: string) {
      return JSON.parse(readFileSync(value.file, "utf8"))[key] as T | undefined
    },
    async update(key: string, item: unknown) {
      const data = JSON.parse(await readFile(value.file, "utf8"))
      if (item === undefined) delete data[key]
      if (item !== undefined) data[key] = item
      await writeFile(value.file, JSON.stringify(data))
      await hook?.(key, item)
    },
  }
  const settings = () =>
    new BrainSettings(storage, {
      async get() {
        return "synthetic"
      },
      async store() {},
      async delete() {},
    })
  return {
    ...value,
    storage,
    settings,
    async cleanup() {
      expect(path.dirname(value.root)).toBe(path.resolve(tmpdir()))
      expect(path.basename(value.root).startsWith("raya-namespace-test-")).toBe(true)
      await rm(value.root, { recursive: true, force: true })
    },
  }
}

async function inventory(root: string) {
  const rows: Record<string, string> = {}
  async function walk(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) await walk(file)
      if (item.isFile()) rows[path.relative(root, file)] = sha(await readFile(file))
    }
  }
  await walk(root)
  return rows
}

test("reviewed committed capture restores admission with an audit and no note or ledger replay", async () => {
  const value = await fixture()
  try {
    const original = value.storage.get("raya.secondBrain.setup")
    const debt = value.settings().pending()
    const turns = value.storage.get("raya.secondBrain.personalCapture.turns")
    const before = await inventory(value.notes)
    const settings = value.settings()
    await expect(settings.load()).rejects.toThrow("pending original settlement")
    const service = new BrainService(settings, process.cwd())
    const result = await service.recoverCapture(value.turn, async () => true)
    expect(result?.requestSettlement).toBe(false)
    expect(result?.replay).toBe(false)
    expect(result?.indexConfirmed).toBe(false)
    expect(settings.pending()).toBeUndefined()
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(turns)
    expect(await inventory(value.notes)).toEqual(before)
    expect((await settings.load())?.launch?.predecessor).toEqual(result?.closure.closed)
    const audit = value.storage.get<{
      phase: string
      previous: unknown
      debt: unknown
      turn: unknown
      requestSettlement: boolean
    }>(`raya.secondBrain.committedCaptureRecovery.${result?.capture}`)
    expect(audit?.phase).toBe("applied")
    expect(audit?.previous).toEqual(original)
    expect(audit?.debt).toEqual(debt)
    expect(audit?.turn).toEqual(value.turn)
    expect(audit?.requestSettlement).toBe(false)
    expect((await service.status()).status).toBe("disconnected")
    await service.dispose()
  } finally {
    await value.cleanup()
  }
}, 30000)

test("committed capture cancellation and changed reviewed ledger preserve pending records", async () => {
  const value = await fixture()
  try {
    const original = await readFile(value.file)
    const settings = value.settings()
    expect(await settings.recoverCapture(process.cwd(), value.turn, async () => false)).toBeUndefined()
    expect(await readFile(value.file)).toEqual(original)
    await expect(
      settings.recoverCapture(process.cwd(), value.turn, async () => {
        await value.storage.update("raya.secondBrain.personalCapture.turns", [])
        return true
      }),
    ).rejects.toThrow("Reviewed committed capture changed")
    expect(settings.pending()).toBeDefined()
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual([])
  } finally {
    await value.cleanup()
  }
}, 30000)

test("committed capture persistence failures restore original uncertainty and allow reviewed retry", async () => {
  const fault = { enabled: true }
  const value = await fixture(async (key, item) => {
    if (fault.enabled && key === "raya.secondBrain.control.uncertainty" && item === undefined) {
      fault.enabled = false
      throw new Error("Synthetic original persistence failure")
    }
  })
  try {
    const original = value.storage.get("raya.secondBrain.setup")
    const settings = value.settings()
    const debt = settings.pending()
    await expect(settings.recoverCapture(process.cwd(), value.turn, async () => true)).rejects.toThrow(
      "Synthetic original persistence failure",
    )
    expect(value.storage.get("raya.secondBrain.setup")).toEqual(original)
    expect(settings.pending()).toEqual(debt)
    const result = await settings.recoverCapture(process.cwd(), value.turn, async () => true)
    expect(result?.capture).toBe(value.turn.id)
    expect(settings.pending()).toBeUndefined()
  } finally {
    await value.cleanup()
  }
}, 30000)

for (const stage of ["state", "verified", "clear", "applied"])
  test(`cold committed capture recovery resumes the exact ${stage} interruption checkpoint`, async () => {
    const value = await fixture()
    try {
      const before = await inventory(value.notes)
      const turns = value.storage.get("raya.secondBrain.personalCapture.turns")
      const child = Bun.spawn(
        [process.execPath, path.resolve("tests/unit/fixtures/committed-capture-crash.ts"), value.file, stage],
        {
          cwd: process.cwd(),
          windowsHide: true,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, err).toBe(71)
      expect(out).toBe("")
      expect(err).toBe("")
      const prior = value.storage.get<{ phase: string }>(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}`)
      expect(prior?.phase).toBe(stage === "state" ? "prepared" : stage === "applied" ? "applied" : "verified")
      const settings = value.settings()
      await expect(settings.load()).rejects.toThrow("Interrupted committed capture recovery must finish")
      const result = await settings.recoverCapture(process.cwd(), value.turn, async () => true)
      expect(result?.capture).toBe(value.turn.id)
      expect(settings.pending()).toBeUndefined()
      expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(turns)
      expect(await inventory(value.notes)).toEqual(before)
      expect(
        value.storage.get<{ phase: string }>(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}`)?.phase,
      ).toBe("applied")
    } finally {
      await value.cleanup()
    }
  }, 60000)
