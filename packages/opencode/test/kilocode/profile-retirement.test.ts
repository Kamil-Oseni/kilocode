import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

for (const mode of ["empty", "used", "failed", "retarget", "peer"]) {
  test(`actual outer retirement retains only successful participating-root observations: ${mode}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-retirement-observation-"))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/profile-retirement.ts"), mode, dir],
      {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          KILO_TEST_HOME: dir,
          XDG_CONFIG_HOME: path.join(dir, "config"),
          XDG_CACHE_HOME: path.join(dir, "cache"),
          XDG_STATE_HOME: path.join(dir, "state"),
          RAYA_DB: path.join(dir, "unused-legacy.db"),
          XDG_DATA_HOME: path.join(dir, "data"),
        },
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      expect(await child.exited, await stderr).toBe(0)
      expect(await stdout).toContain(`"mode":"${mode}"`)
      expect(await Bun.file(path.join(dir, "unused-legacy.db")).exists()).toBe(false)
      await fs.rm(dir, { recursive: true, force: true })
    } catch (err) {
      await fs.writeFile(path.join(dir, "failure.txt"), String(err))
      console.error(`Retained retirement observation fixture: ${dir}`)
      throw err
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
      if (await Bun.file(dir).exists())
        await fs.writeFile(
          path.join(dir, "child.json"),
          JSON.stringify({ pid: child.pid, code: child.exitCode, stdout: await stdout, stderr: await stderr }),
        )
    }
  }, 20_000)
}
