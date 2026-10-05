import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["read", "rename"])
  test(`actual auth ${mode} failure is typed and retirement retains its native cause`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "raya-auth-error-"))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KILO_TEST_HOME: dir,
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
    }
    delete env.KILO_AUTH_CONTENT
    delete env.RAYA_AUTH_CONTENT
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/auth-publication-error.ts"), mode, dir],
      { env, stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 15_000)
    try {
      expect(await child.exited, await stderr).toBe(0)
      expect(JSON.parse(await stdout)).toEqual({
        typed: true,
        rawRetained: true,
        sticky: true,
        mode,
        changed: mode === "rename",
      })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
