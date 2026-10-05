import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { withTimeout } from "../../src/util/timeout"

for (const mode of [
  "clean",
  "foreign",
  "held",
  "failed",
  "capture",
  "capture-background",
  "handoff-background",
  "receipt-malformed",
  "receipt-duplicate",
  "receipt-relative",
  "receipt-flags",
  "receipt-canonical",
])
  test.skipIf(process.platform !== "win32")(
    `daemon ${mode} ownership uses actual correlated cleanup and native exit`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "raya-daemon-owned-"))
      const child = Bun.spawn(
        [process.execPath, "--conditions=browser", "test/kilocode/fixtures/daemon-ownership.ts", mode],
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
            RAYA_DAEMON_TEST_ROOT: root,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            RAYA_DB: path.join(root, "private.db"),
            KILO_DB: path.join(root, "private.db"),
            KILO_TEST_DAEMON_STATE_DIR: path.join(root, "controller"),
            KILO_TEST_DAEMON_LOG_DIR: path.join(root, "logs"),
            RAYA_DAEMON_GENERATION: "",
            RAYA_DAEMON_REQUEST: "",
            RAYA_DAEMON_RECEIPT: "",
            RAYA_NO_DAEMON: "1",
            KILO_NO_DAEMON: "1",
            KILO_PURE: "1",
            KILO_AUTH_CONTENT: "{}",
            RAYA_AUTH_CONTENT: "{}",
            RAYA_CONFIG_CONTENT: "",
            KILO_CONFIG_CONTENT: '{"formatter":false,"lsp":false,"permission":"deny","enabled_providers":[]}',
            KILO_DISABLE_MODELS_FETCH: "1",
            RAYA_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_AUTOUPDATE: "1",
            KILO_DISABLE_PROJECT_CONFIG: "1",
            KILO_CONFIG: "",
            RAYA_CONFIG: "",
            KILO_CONFIG_DIR: "",
            RAYA_CONFIG_DIR: "",
          },
        },
      )
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      try {
        const [code, stdout, stderr] = await withTimeout(
          Promise.all([child.exited, ...output]),
          120000,
          `Retained private daemon fixture ${root}`,
        )
        await Bun.write(path.join(root, "stdout.log"), stdout)
        await Bun.write(path.join(root, "stderr.log"), stderr)
        expect(code, `Retained ${root}: ${stderr}`).toBe(0)
        const receipt = await Bun.file(path.join(root, "receipt.json")).json()
        expect(receipt).toMatchObject({ passed: true, forced: false, mode, portableCaptureAuthorized: false })
        expect(receipt.processes.every((row: { absent: boolean }) => row.absent)).toBe(true)
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL")
        await withTimeout(child.exited, 10000, `Owned fixture PID remainslive ${child.pid}`)
        const [stdout, stderr] = await Promise.all(output)
        await Bun.write(path.join(root, "stdout.log"), stdout)
        await Bun.write(path.join(root, "stderr.log"), stderr)
      }
    },
    135000,
  )
