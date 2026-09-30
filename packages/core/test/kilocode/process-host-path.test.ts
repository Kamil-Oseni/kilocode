import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { readProcessMode, resolveProcessHostLocation } from "../../src/kilocode/process-host"

describe("native process host package path", () => {
  test("resolves Windows Bun virtual B: source beside the installed executable", () => {
    const exe = "C:\\Users\\User\\.vscode\\extensions\\eden.raya-snapshot\\bin\\kilo.exe"
    const meta = "file:///B:/native/kilocode/process-host/index.ts"
    expect(resolveProcessHostLocation(meta, exe, () => true)).toEqual({ directory: path.dirname(exe), bundled: true })
    expect(resolveProcessHostLocation(meta, exe, () => false)).toEqual({ directory: path.dirname(exe), bundled: true })
  })

  test("preserves a physical development source tree", () => {
    const source = path.resolve("packages/core/src/kilocode/process-host/index.ts")
    const meta = pathToFileURL(source).href
    expect(resolveProcessHostLocation(meta, process.execPath, (file) => file === source)).toEqual({
      directory: path.resolve(path.dirname(source), "../../../native/kilocode/bin"),
      bundled: false,
    })
  })

  test("preserves older Bun virtual URL markers", () => {
    const exe = "C:\\raya\\bin\\kilo.exe"
    expect(resolveProcessHostLocation("file:///B:/~BUN/native/index.ts", exe, () => false)).toEqual({
      directory: path.dirname(exe),
      bundled: true,
    })
  })

  test("fails closed on missing or malformed installed capability declarations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "raya-process-mode-test-"))
    try {
      expect(() => readProcessMode(dir)).toThrow()
      await writeFile(path.join(dir, "raya-process-mode.json"), JSON.stringify({ version: 2, mode: "native" }))
      expect(() => readProcessMode(dir)).toThrow("Native process capability declaration invalid")
      await writeFile(path.join(dir, "raya-process-mode.json"), JSON.stringify({ version: 1, mode: "native" }))
      expect(readProcessMode(dir)).toBe("native")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
