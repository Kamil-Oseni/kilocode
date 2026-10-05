import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

for (const mode of [
  "unused",
  "closed",
  "flush",
  "graphs",
  "held",
  "held-open",
  "open-failure",
  "write-failure",
  "close-failure",
]) {
  test(`Effect native file logger retirement: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-effect-file-logger-"))
    const child = Bun.spawn([process.execPath, "run", "test/kilocode/fixture/file-logger-retirement.ts", mode], {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, RAYA_LOGGER_FIXTURE: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      child.kill("SIGKILL")
    }, 15_000)
    try {
      const code = await child.exited
      const [stdout, stderr] = await output
      await Bun.write(join(root, "stdout.log"), stdout)
      await Bun.write(join(root, "stderr.log"), stderr)
      expect(code, `Retained profile ${root}; ${stderr}`).toBe(0)
      expect(forced).toBe(false)
      expect(await Bun.file(join(root, "receipt.json")).json()).toMatchObject({
        ok: true,
        mode,
        portableCaptureAuthorized: false,
      })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
      const [stdout, stderr] = await output
      await Bun.write(join(root, "stdout.log"), stdout)
      await Bun.write(join(root, "stderr.log"), stderr)
      const absent = (() => {
        try {
          process.kill(child.pid, 0)
          return false
        } catch (err) {
          if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
          throw err
        }
      })()
      await Bun.write(join(root, "cleanup.json"), JSON.stringify({ pid: child.pid, absent, forced }))
      expect(absent).toBe(true)
    }
  }, 20_000)
}
