import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../src/util/timeout"

for (const mode of ["inline", "detached"]) {
  test(`protected scheduler ${mode} model body aborts native transport and joins cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-scheduler-model-cancellation-"))
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (key.startsWith("OTEL_") || /(API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
    const cfg = '{"formatter":false,"lsp":false,"enabled_providers":[],"experimental":{"openTelemetry":false}}'
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      KILO_TEST_HOME: root,
      RAYA_SCHEDULER_PROFILE: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      RAYA_DB: join(root, "raya.db"),
      KILO_DB: join(root, "raya.db"),
      RAYA_CONFIG_CONTENT: cfg,
      KILO_CONFIG_CONTENT: cfg,
      RAYA_CONFIG: "",
      KILO_CONFIG: "",
      RAYA_CONFIG_DIR: "",
      KILO_CONFIG_DIR: "",
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_MODELS_PATH: "",
      KILO_MODELS_PATH: "",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      RAYA_NO_DAEMON: "1",
      KILO_NO_DAEMON: "1",
      KILO_PURE: "1",
    })
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/scheduler-model-cancellation.ts", mode],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        windowsHide: true,
      },
    )
    const streams = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    let forced = false
    try {
      const code = await withTimeout(child.exited, 20_000, `Retained cancellation profile ${root}`)
      const [stdout, stderr] = await streams
      await Promise.all([Bun.write(join(root, "stdout.log"), stdout), Bun.write(join(root, "stderr.log"), stderr)])
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      const receipt = await Bun.file(join(root, "receipt.json")).json()
      expect(receipt).toMatchObject({
        passed: true,
        mode,
        requests: 1,
        aborted: 1,
        finalizers: 1,
        scheduler: { closed: true, active: 0 },
        portable: false,
      })
    } finally {
      if (child.exitCode === null) {
        forced = true
        child.kill("SIGKILL")
      }
      await child.exited
      const [stdout, stderr] = await streams
      await Promise.all([
        Bun.write(join(root, "stdout.log"), stdout),
        Bun.write(join(root, "stderr.log"), stderr),
        Bun.write(join(root, "cleanup.json"), JSON.stringify({ pid: child.pid, code: child.exitCode, forced })),
      ])
      expect(forced, `Forced child is a failed cancellation proof: ${root}`).toBe(false)
      const absent = (() => {
        try {
          process.kill(child.pid, 0)
          return false
        } catch (err) {
          if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
          throw err
        }
      })()
      expect(absent).toBe(true)
    }
  }, 30_000)
}
