import { expect, test } from "bun:test"
import { resolve } from "node:path"

for (const mode of ["joined", "failed", "remaining", "overlap"])
  test(`terminal native database retirement: ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, "test", "./test/kilocode/fixture/profile-database-terminal.ts"], {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, RAYA_TEST_DATABASE_TERMINAL: mode },
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
      expect(stdout + stderr).toContain("1 pass")
      expect(stdout + stderr).toContain("0 fail")
      const absent = (() => {
        try {
          process.kill(child.pid, 0)
          return false
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return true
          throw err
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
