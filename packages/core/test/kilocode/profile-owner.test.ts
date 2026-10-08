import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { registerProfileFile, coordinateNativeRoots } from "../../src/kilocode/profile-maintenance"
import { birth, retired } from "../../src/kilocode/profile-owner"
import { NativeProcess } from "../../src/kilocode/process-host"

const check = process.platform === "win32" && process.arch === "x64" ? test : test.skip

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "raya-owner-identity-"))
  const dir = path.join(base, "payload")
  await mkdir(dir)
  const root = { kind: "json" as const, path: dir }
  const owner = registerProfileFile(root)
  const locks = path.join(path.dirname(dir), ".raya-profile-locks")
  const folders = await readdir(locks)
  for (const folder of folders.filter((name) => name.endsWith(".owners"))) {
    for (const name of await readdir(path.join(locks, folder))) {
      const file = path.join(locks, folder, name)
      const raw = await readFile(file, "utf8")
      const record = JSON.parse(raw)
      if (record.root !== dir.toLowerCase() || record.pid !== process.pid) continue
      return { root, owner, file, raw, record }
    }
  }
  throw new Error("Actual profile owner marker was not found")
}

check("native constructor records the actual kernel birth and refuses the exact live owner", async () => {
  const cfg = await fixture()
  try {
    expect(cfg.record.version).toBe(2)
    const actual = await NativeProcess.inspect(process.pid)
    expect(actual).toMatchObject({ status: "owned", birth: cfg.record.birth })
    expect(birth()).toBe(cfg.record.birth)
    expect(await retired(process.pid, cfg.record.birth)).toBe(false)
    await assert.rejects(
      coordinateNativeRoots([cfg.root], async () => true),
      /remain live or uncertain/,
    )
    expect(await readFile(cfg.file, "utf8")).toBe(cfg.raw)
  } finally {
    cfg.owner.release()
  }
  expect((await coordinateNativeRoots([cfg.root], async () => true)).value).toBe(true)
})

check("exact kernel birth mismatch retires only the record and leaves the current PID alive", async () => {
  const cfg = await fixture()
  cfg.owner.release()
  const other = (BigInt(cfg.record.birth) - 1n).toString()
  const raw = JSON.stringify({ ...cfg.record, birth: other })
  await writeFile(cfg.file, raw, { flag: "wx" })
  expect(await retired(process.pid, other)).toBe(true)
  expect((await coordinateNativeRoots([cfg.root], async () => true)).value).toBe(true)
  expect(await Bun.file(cfg.file).exists()).toBe(false)
  expect(() => process.kill(process.pid, 0)).not.toThrow()
})

check("legacy live PID remains held without a birth certificate", async () => {
  const cfg = await fixture()
  cfg.owner.release()
  const { birth: ignored, ...record } = cfg.record
  expect(ignored).toBeDefined()
  const raw = JSON.stringify({ ...record, version: 1 })
  await writeFile(cfg.file, raw, { flag: "wx" })
  await assert.rejects(
    coordinateNativeRoots([cfg.root], async () => true),
    /remain live or uncertain/,
  )
  expect(await readFile(cfg.file, "utf8")).toBe(raw)
  await unlink(cfg.file)
})

check("bundled Node ownership matches the native kernel birth and retires after its original close", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-node-owner-identity-"))
  const root = { kind: "json" as const, path: path.join(dir, "payload") }
  await mkdir(root.path)
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/profile-owner.node.ts")],
    target: "node",
    format: "esm",
  })
  expect(built.success).toBe(true)
  const file = path.join(dir, "node-owner.mjs")
  await Bun.write(file, built.outputs[0])
  const child = Bun.spawn(["node", file, dir], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const streams = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  try {
    const stop = performance.now() + 5_000
    while (!(await Bun.file(path.join(dir, "ready")).exists())) {
      if (child.exitCode !== null || performance.now() >= stop)
        throw new Error("Node profile identity fixture did not start")
      await Bun.sleep(10)
    }
    const ready = await Bun.file(path.join(dir, "ready")).json()
    expect(ready.pid).toBe(child.pid)
    expect(await NativeProcess.inspect(child.pid)).toMatchObject({ status: "owned", birth: ready.birth })
    await assert.rejects(
      coordinateNativeRoots([root], async () => true),
      /remain live or uncertain/,
    )
    await writeFile(path.join(dir, "release"), "release")
    expect(await child.exited).toBe(0)
    expect(await streams).toEqual(["", ""])
    expect((await coordinateNativeRoots([root], async () => true)).value).toBe(true)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    await streams
  }
})

for (const value of [undefined, "0", "18446744073709551616", "invalid"])
  check(`native owner with invalid birth ${String(value)} stays uncertain`, async () => {
    const cfg = await fixture()
    cfg.owner.release()
    const raw = JSON.stringify({ ...cfg.record, birth: value })
    await writeFile(cfg.file, raw, { flag: "wx" })
    await assert.rejects(
      coordinateNativeRoots([cfg.root], async () => true),
      /ownership is uncertain/,
    )
    expect(await readFile(cfg.file, "utf8")).toBe(raw)
    await unlink(cfg.file)
  })
