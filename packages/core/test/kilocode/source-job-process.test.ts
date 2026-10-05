import { test, expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

for (const mode of [
  "held",
  "handoff",
  "controller",
  "broker",
  "forced",
  "wrongnonce",
  "changedroot",
  "broker-env",
  "broker-late",
])
  test.skipIf(process.platform !== "win32")(
    `native source job ${mode} tracks detached descendants before execution`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "raya-source-job-"))
      const child = Bun.spawn(
        [process.execPath, "--conditions=browser", "test/kilocode/fixtures/source-job.ts", mode],
        {
          cwd: path.resolve(import.meta.dir, "../.."),
          windowsHide: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            KILO_TEST_HOME: root,
            RAYA_SOURCE_JOB_TEST_ROOT: root,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            KILO_DB: path.join(root, "private.db"),
            RAYA_DB: path.join(root, "private.db"),
            KILO_CONFIG_CONTENT: '{"enabled_providers":[]}',
            RAYA_CONFIG_CONTENT: "",
            KILO_AUTH_CONTENT: "{}",
            RAYA_AUTH_CONTENT: "{}",
            KILO_DISABLE_MODELS_FETCH: "1",
            RAYA_DISABLE_MODELS_FETCH: "1",
            KILO_NO_DAEMON: "1",
            RAYA_NO_DAEMON: "1",
          },
        },
      )
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      const timer = setTimeout(() => child.kill("SIGKILL"), 60000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
        await Bun.write(path.join(root, "parent.stdout.log"), stdout)
        await Bun.write(path.join(root, "parent.stderr.log"), stderr)
        expect(code, `Retained ${root}: ${stderr}`).toBe(0)
        const receipt = await Bun.file(path.join(root, "receipt.json")).json()
        expect(receipt).toMatchObject({ passed: true, forced: false, mode, portableCaptureAuthorized: false })
        expect(receipt.processes.every((row: { absent: boolean }) => row.absent)).toBe(true)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
    65000,
  )
