import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["held", "nonzero", "wrongticket", "forced", "missingack", "policy", "member", "rootexit"])
  test.skipIf(process.platform !== "win32")(
    `actual source launcher ${mode} binds source context and held native family observer`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-launch-"))
      const child = Bun.spawn(
        [process.execPath, "--conditions=browser", "test/kilocode/fixtures/source-launch.ts", mode],
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
            RAYA_SOURCE_LAUNCH_TEST_ROOT: root,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            KILO_DB: path.join(root, "private.db"),
            RAYA_DB: path.join(root, "private.db"),
            KILO_AUTH_CONTENT: "{}",
            RAYA_AUTH_CONTENT: "{}",
            KILO_DISABLE_MODELS_FETCH: "1",
            RAYA_DISABLE_MODELS_FETCH: "1",
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
        expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
          passed: true,
          portableCaptureAuthorized: false,
        })
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
    65000,
  )
