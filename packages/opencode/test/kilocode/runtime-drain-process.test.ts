import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

for (const mode of ["owners", "app-unused", "app-used"]) {
  test(`outer runtime registry retires ${mode} in an isolated process`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-runtime-drain-"))
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/runtime-drain.ts", mode],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          HOME: dir,
          KILO_TEST_HOME: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CACHE_HOME: join(dir, "cache"),
          XDG_STATE_HOME: join(dir, "state"),
          RAYA_DB: join(dir, "raya.db"),
          KILO_NO_DAEMON: "1",
          RAYA_NO_DAEMON: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_AUTH_CONTENT: "{}",
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const drains = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000)
    try {
      const exit = await child.exited
      const [stdout, stderr] = await drains
      expect(exit, `${stdout}\n${stderr}\nRetained fixture: ${dir}`).toBe(0)
      expect(stdout).toContain(JSON.stringify({ ok: true, mode, instances: 0 }))
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await drains
    }
  }, 60_000)
}
