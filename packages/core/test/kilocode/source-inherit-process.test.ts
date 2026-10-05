import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform !== "win32")(
  "actual source guardian preserves inherited stdin bytes and stdout",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-inherit-"))
    const child = Bun.spawn([process.execPath, "--conditions=browser", "test/kilocode/fixtures/source-inherit.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        RAYA_SOURCE_INHERIT_TEST_ROOT: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        RAYA_DB: path.join(root, "private.db"),
        KILO_DB: path.join(root, "private.db"),
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
      },
    })
    const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
    try {
      const deadline = Date.now() + 15000
      while (!(await Bun.file(path.join(root, "ready")).exists())) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`Inherited source startup failed; retained ${root}`)
        await Bun.sleep(10)
      }
      await child.stdin.write("RAYA_INHERITED_INPUT café 日本語 😀")
      await child.stdin.end()
      const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
      await Bun.write(path.join(root, "stdout.log"), stdout)
      await Bun.write(path.join(root, "stderr.log"), stderr)
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      expect(stdout).toContain("RAYA_INHERITED_INPUT café 日本語 😀")
      expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
        passed: true,
        forced: false,
        consoleKeyboardVerified: false,
      })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  },
  35000,
)
