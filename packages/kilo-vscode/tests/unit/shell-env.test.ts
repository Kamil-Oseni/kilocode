import { afterEach, describe, expect, it } from "bun:test"
import os from "node:os"
import path from "node:path"
import { canonicalizePath } from "../../src/agent-manager/project/paths"
import { getShellEnvironment, execWithShellEnv, clearShellEnvCache } from "../../src/agent-manager/shell-env"

afterEach(() => {
  clearShellEnvCache()
})

describe("getShellEnvironment", () => {
  it("returns an object with PATH", async () => {
    const env = await getShellEnvironment()
    expect(env).toBeDefined()
    expect(typeof env.PATH).toBe("string")
    expect(env.PATH!.length).toBeGreaterThan(0)
  })

  it("returns HOME", async () => {
    const env = await getShellEnvironment()
    expect(typeof env.HOME).toBe("string")
  })

  it("caches results across calls", async () => {
    const first = await getShellEnvironment()
    const second = await getShellEnvironment()
    expect(first.PATH).toBe(second.PATH)
  })

  it("returns a copy (mutations don't corrupt cache)", async () => {
    const first = await getShellEnvironment()
    first.PATH = "/mutated"
    const second = await getShellEnvironment()
    expect(second.PATH).not.toBe("/mutated")
  })

  it("handles multiline env values without corrupting PATH", async () => {
    // PATH should never contain newlines — verify it parses correctly
    // even if other env vars have multiline values (e.g. BASH_FUNC_*)
    const env = await getShellEnvironment()
    expect(env.PATH).toBeDefined()
    expect(env.PATH).not.toContain("\n")
  })
})

describe("execWithShellEnv", () => {
  it("executes a simple command", async () => {
    const { stdout } = await execWithShellEnv(process.execPath, ["-e", "process.stdout.write('hello')"]) // raya_change
    expect(stdout.trim()).toBe("hello")
  })

  it("passes cwd option through", async () => {
    const { stdout } = await execWithShellEnv(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
      cwd: os.tmpdir(),
    }) // raya_change - use an executable and directory available on every host
    expect(canonicalizePath(stdout.trim())).toBe(canonicalizePath(path.resolve(os.tmpdir())))
  })

  it("throws on non-ENOENT errors", async () => {
    await expect(execWithShellEnv(process.execPath, ["-e", "process.exit(1)"])).rejects.toThrow() // raya_change
  })

  it("concurrent calls don't reject prematurely", async () => {
    // Both calls should succeed — neither should throw due to a race
    const [a, b] = await Promise.all([
      execWithShellEnv(process.execPath, ["-e", "process.stdout.write('first')"]),
      execWithShellEnv(process.execPath, ["-e", "process.stdout.write('second')"]),
    ]) // raya_change - avoid POSIX shell builtins on Windows
    expect(a.stdout.trim()).toBe("first")
    expect(b.stdout.trim()).toBe("second")
  })
})

describe("clearShellEnvCache", () => {
  it("forces fresh resolution on next call", async () => {
    const first = await getShellEnvironment()
    clearShellEnvCache()
    const second = await getShellEnvironment()
    // Both should succeed and contain PATH
    expect(first.PATH).toBeDefined()
    expect(second.PATH).toBeDefined()
  })
})
