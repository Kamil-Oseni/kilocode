import { expect, test } from "bun:test"
import path from "node:path"
import { reply, type Op } from "../../src/second-brain/control/frames"
import { Transport } from "../../src/second-brain/control/transport"
import { observe } from "../../src/second-brain/control/identity"
import { packaged } from "../../src/second-brain/control/index"
import { protect } from "../../src/second-brain/control/protection"
import { spawn } from "../../src/util/process"
import type { Publication } from "../../src/second-brain/client-v2"
import { rm, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

test("actual private capture bridge replies satisfy strict original-operation frames", async () => {
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      "-I",
      "-S",
      "-B",
      path.join(process.cwd(), "tests/fixtures/memory_capture_control.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(error).toContain("Ran 10 tests")
  expect(error).toContain("OK")
  const rows = output.trim().split("\n")
  expect(rows.length).toBe(5)
  for (const line of rows) {
    const row = JSON.parse(line) as { root: string; op: Op; seq: number; raw: string; ok: boolean }
    const parse = () => reply(Buffer.from(row.raw), row.op, row.seq, row.root)
    if (row.ok) {
      expect(parse()).toBeDefined()
      continue
    }
    expect(parse).toThrow()
    if (row.raw.includes("CaptureCapacity")) {
      const err = (() => {
        try {
          parse()
        } catch (err) {
          return err
        }
      })()
      expect(err).toHaveProperty("code", "capture_source_capacity")
    }
  }
}, 30_000)

test("actual capacity denial fences intake and joins original native child without transport corruption", async () => {
  const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
  const prep = Bun.spawn(
    [python, "-I", "-S", "-B", path.resolve("tests/fixtures/memory_capture_control.py"), "--prepare-native"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(prep.stdout).text(),
    new Response(prep.stderr).text(),
    prep.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(error).toBe("")
  const fixture = JSON.parse(output) as { root: string; body: Publication; sha: string; config: string }
  const root = path.resolve(fixture.root)
  expect(path.dirname(root).toLowerCase()).toBe(path.resolve(tmpdir()).toLowerCase())
  expect(path.basename(root)).toStartWith("raya-capture-")
  const tmp = await mkdtemp(path.join(tmpdir(), "raya-memory-control-capacity-"))
  await protect(tmp)
  const cfg = path.join(tmp, "bootstrap.private.json")
  await writeFile(cfg, await readFile(fixture.config), { flag: "wx", mode: 0o600 })
  const helper = await packaged(path.resolve("."))
  const child = spawn(python, ["-I", "-S", "-B", "-u", path.resolve("script/memory/control.py"), "--config", cfg], {
    cwd: tmp,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const owner = new Transport(child, root)
  try {
    owner.bind(
      await observe(child, python, helper.helper, "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2"),
    )
    await expect(owner.captureAuthorize(fixture.body, fixture.sha)).rejects.toHaveProperty(
      "code",
      "capture_source_capacity",
    )
    expect(owner.snapshot().fenced).toBe(true)
    expect(owner.snapshot().errors).toEqual([])
    expect(owner.snapshot().mutationUncertain).toBe(false)
  } finally {
    const closed = await owner.close()
    expect(closed).toEqual({ code: 0, signal: null, stdout: true, stderr: true, errors: [] })
    await rm(root, { recursive: true })
    await rm(tmp, { recursive: true })
  }
}, 30_000)
