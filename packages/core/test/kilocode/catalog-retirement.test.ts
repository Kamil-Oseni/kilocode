import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of [
  "unused",
  "closed",
  "held",
  "alias",
  "periodic",
  "scope",
  "idle",
  "interrupt",
  "timeout",
  "publication",
  "corrupt",
  "failure",
  "transport-failure",
  "read-failure",
  "external-read",
  "stat-failure",
]) {
  test(`catalog production retirement: ${mode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-catalog-retirement-"))
    const child = Bun.spawn([process.execPath, "run", "./test/kilocode/fixture/catalog-retirement.ts", mode], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        RAYA_CATALOG_FIXTURE: root,
        RAYA_MODELS_URL: "",
        KILO_MODELS_URL: "",
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_PURE: "1",
      },
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      child.kill()
    }, 25_000)
    try {
      const code = await child.exited
      const [stdout, stderr] = await output
      console.log(JSON.stringify({ mode, root, pid: child.pid, code, forced }))
      expect(code, stdout + stderr).toBe(0)
      expect(forced).toBe(false)
      const receipt = JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"))
      expect(receipt.ok).toBe(true)
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
  }, 30_000)
}
