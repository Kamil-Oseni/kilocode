import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["accepted", "wrongclient", "wrongserver", "timeout"])
  test.skipIf(process.platform !== "win32")(
    `actual private pipe ${mode} verifies native peers without publishing its secret`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-pipe-"))
      const child = Bun.spawn(
        [process.execPath, "--conditions=browser", "test/kilocode/fixtures/source-pipe.ts", mode],
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
            RAYA_SOURCE_PIPE_TEST_ROOT: root,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            KILO_DB: path.join(root, "private.db"),
            RAYA_DB: path.join(root, "private.db"),
            KILO_AUTH_CONTENT: "{}",
            RAYA_AUTH_CONTENT: "{}",
          },
        },
      )
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
        await Bun.write(path.join(root, "parent.stdout.log"), stdout)
        await Bun.write(path.join(root, "parent.stderr.log"), stderr)
        expect(code, `Retained ${root}: ${stderr}`).toBe(0)
        expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
          passed: true,
          absent: true,
          secretPublished: false,
          portableCaptureAuthorized: false,
        })
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
    30000,
  )
