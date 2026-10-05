import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publish } from "../../src/kilocode/profile-record"
import { coordinateNativeRoots } from "../../src/kilocode/profile-maintenance"
import { Hash } from "../../src/util/hash"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-profile-record-"))
  const root = { kind: "json" as const, path: path.join(dir, "storage") }
  await mkdir(root.path)
  return {
    dir,
    root,
    locks: path.join(dir, ".raya-profile-locks"),
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("complete publication is exclusive and keeps an occupied final record unchanged", async () => {
  await using tmp = await fixture()
  const dir = path.join(tmp.locks, "owners")
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "record.json")
  const record = JSON.stringify({ pid: process.pid, evidence: "café 日本語 😀" })
  publish(file, record)
  expect(await readFile(file, "utf8")).toBe(record)
  expect((await stat(file)).nlink).toBe(1)
  expect(() => publish(file, "different")).toThrow(AggregateError)
  expect(await readFile(file, "utf8")).toBe(record)
  expect((await readdir(tmp.locks)).filter((name) => name.endsWith(".pending"))).toEqual([])
})

test("actual interrupted publishers expose complete records and dead known aliases stay inert", async () => {
  for (const mode of ["crash", "alias"]) {
    await using tmp = await fixture()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "profile-record-worker.ts"), tmp.root.path, mode],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const reader = child.stdout.getReader()
    const timer = setTimeout(() => child.kill(), 10000)
    try {
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain("ready")
      if (mode === "crash") child.kill()
      await child.exited
      const names = (await readdir(tmp.locks)).filter((name) => name.endsWith(".owners") || name.endsWith(".writers"))
      expect(names.length).toBe(2)
      for (const name of names) {
        const files = await readdir(path.join(tmp.locks, name))
        expect(files.length).toBeGreaterThan(0)
        for (const file of files) {
          const value = JSON.parse(await readFile(path.join(tmp.locks, name, file), "utf8"))
          expect(value.pid).toBe(child.pid)
          expect(typeof value.token).toBe("string")
        }
      }
      await coordinateNativeRoots([tmp.root], async () => undefined, { timeoutMs: 5000 })
      for (const name of names) expect(await readdir(path.join(tmp.locks, name))).toEqual([])
      if (mode === "alias") {
        const files = (await readdir(tmp.locks)).filter((name) => name.startsWith(".abandoned-"))
        expect(files.length).toBe(2)
        for (const file of files)
          expect(JSON.parse(await readFile(path.join(tmp.locks, file), "utf8")).pid).toBe(child.pid)
      }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  }
}, 20000)

test("preexisting empty writer and malformed native owner remain refused", async () => {
  for (const kind of ["writers", "owners"]) {
    await using tmp = await fixture()
    const key = Hash.fast(
      `raya.profile.json:${process.platform === "win32" ? tmp.root.path.toLowerCase() : tmp.root.path}`,
    )
    const dir = path.join(tmp.locks, `${key}.${kind}`)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "unknown.json"), "")
    await assert.rejects(
      coordinateNativeRoots([tmp.root], async () => undefined, { timeoutMs: 100 }),
      kind === "writers" ? /timed out draining/ : /JSON/,
    )
    expect(await readFile(path.join(dir, "unknown.json"), "utf8")).toBe("")
  }
})
