import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../src/util/timeout"

for (const mode of ["unused", "loaded", "held", "failed"])
  test(`outer and worker retirement join actual ${mode} legacy SQLite ownership`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-legacy-retirement-"))
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/legacy-retirement.ts", mode],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          APPDATA: join(root, "roaming"),
          LOCALAPPDATA: join(root, "local"),
          KILO_TEST_HOME: root,
          XDG_DATA_HOME: join(root, "data"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
          RAYA_DB: join(root, "raya.db"),
          KILO_NO_DAEMON: "1",
          RAYA_NO_DAEMON: "1",
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_AUTH_CONTENT: "{}",
          RAYA_AUTH_CONTENT: "{}",
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        windowsHide: true,
      },
    )
    const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    try {
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        45_000,
        `Retained legacy retirement fixture: ${root}`,
      )
      await Bun.write(join(root, "stdout.log"), stdout)
      await Bun.write(join(root, "stderr.log"), stderr)
      expect(code, `Retained profile ${root}; ${stderr}`).toBe(0)
      expect(await Bun.file(join(root, "receipt.json")).json()).toMatchObject({
        passed: true,
        mode,
        coreInstances: 0,
        nativeMarkers: mode === "failed" ? 1 : 0,
        operationMarkers: 0,
        processLocal: true,
        portableCaptureAuthorized: false,
      })
    } finally {
      const forced = child.exitCode === null
      if (forced) child.kill("SIGKILL")
      const [, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        10_000,
        `Legacy retirement child remains live: ${root}`,
      )
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
  }, 60_000)
