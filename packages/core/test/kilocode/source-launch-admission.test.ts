import { expect, test } from "bun:test"
import { mkdtemp, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["malformed", "identity", "ended"])
  test.skipIf(process.platform !== "win32")(
    `pre-Go ${mode} retains primary failure and joins the original native helper and pipes`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-admission-"))
      const temp = path.join(root, "tmp")
      await mkdir(temp)
      const child = Bun.spawn(
        [process.execPath, "--conditions=browser", "test/kilocode/fixtures/source-launch-admission.ts", mode],
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
            RAYA_SOURCE_ADMISSION_TEST_ROOT: root,
            TEMP: temp,
            TMP: temp,
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
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await Bun.write(path.join(root, "parent.stdout.log"), stdout)
      await Bun.write(path.join(root, "parent.stderr.log"), stderr)
      expect(await Bun.file(path.join(root, "original-joined.json")).json()).toMatchObject({
        mode,
        injectionVerified: true,
        targetNeverStarted: true,
        originalExitJoined: true,
        originalCloseJoined: true,
        originalStreamsJoined: true,
        ordinaryRetirement: false,
        primary: mode !== "identity" ? "malformed-header" : "suspended-identity-mismatch",
      })
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      expect(await Bun.file(path.join(root, "passed.json")).json()).toEqual({ passed: true, mode })
    },
    30000,
  )
