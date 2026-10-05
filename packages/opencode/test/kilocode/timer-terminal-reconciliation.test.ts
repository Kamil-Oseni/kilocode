import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../src/util/timeout"

for (const mode of ["delayed"]) {
  test(`Timer reconciliation repairs delayed durable Goal terminal publication`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-timer-terminal-"))
    for (const stage of [mode]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          "test/kilocode/fixtures/timer-terminal-reconciliation.ts",
          stage,
        ],
        {
          cwd: resolve(import.meta.dir, "../.."),
          env: {
            ...process.env,
            HOME: root,
            KILO_TEST_HOME: root,
            RAYA_TIMER_PROFILE: root,
            XDG_DATA_HOME: join(root, "data"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_CACHE_HOME: join(root, "cache"),
            XDG_STATE_HOME: join(root, "state"),
            RAYA_DB: join(root, "raya.db"),
            RAYA_NO_DAEMON: "1",
            KILO_NO_DAEMON: "1",
            KILO_DISABLE_PROJECT_CONFIG: "1",
            KILO_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_AUTOUPDATE: "1",
            KILO_AUTH_CONTENT: "{}",
            RAYA_AUTH_CONTENT: "{}",
            KILO_CONFIG_CONTENT: '{"formatter":false,"lsp":false,"permission":"deny","enabled_providers":[]}',
            RAYA_CONFIG_CONTENT: "",
            KILO_CONFIG: "",
            RAYA_CONFIG: "",
            KILO_CONFIG_DIR: "",
            RAYA_CONFIG_DIR: "",
            KILO_SERVER_PASSWORD: "",
            RAYA_SERVER_PASSWORD: "",
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
          `Retained scheduler fixture: ${root}`,
        )
        await Bun.write(join(root, `${stage}-stdout.log`), stdout)
        await Bun.write(join(root, `${stage}-stderr.log`), stderr)
        expect(code, `Retained profile ${root}; ${stderr}`).toBe(0)
        const receipt = await Bun.file(join(root, "receipt.json")).json()
        expect(receipt).toMatchObject({
          passed: true,
          calls: 3,
          status: "blocked",
          portableCaptureAuthorized: false,
          natural: true,
        })
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL")
        const [, stdout, stderr] = await withTimeout(
          Promise.all([child.exited, ...streams]),
          10_000,
          `Scheduler child remains live: ${root}`,
        )
        await Bun.write(join(root, `${stage}-stdout.log`), stdout)
        await Bun.write(join(root, `${stage}-stderr.log`), stderr)
        const absent = (() => {
          try {
            process.kill(child.pid, 0)
            return false
          } catch (err) {
            if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
            throw err
          }
        })()
        await Bun.write(join(root, `${stage}-cleanup.json`), JSON.stringify({ pid: child.pid, absent }))
        expect(absent).toBe(true)
      }
    }
  }, 120_000)
}
