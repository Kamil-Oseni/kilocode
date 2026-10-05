import { expect, test } from "bun:test"
import { resolve } from "node:path"

// The legacy cases mock broad module graphs. Keep them out of the parent runner
// so real server/runtime tests cannot inherit their replacement exports.
test("CLI shutdown legacy lifecycle cases pass in an isolated module graph", async () => {
  const child = Bun.spawn([process.execPath, "test", "./test/kilocode/cli-shutdown.fixture.ts"], {
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const code = await child.exited
    const [stdout, stderr] = await output
    expect(code, stdout + stderr).toBe(0)
    expect(stdout + stderr).toContain("4 pass")
    expect(stdout + stderr).toContain("0 fail")
    const absent = (() => {
      try {
        process.kill(child.pid, 0)
        return false
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true
        throw error
      }
    })()
    expect(absent).toBe(true)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    await output
  }
}, 40_000)
