import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["natural", "pending", "suspended", "failure", "capture", "late-capture"])
  test.skipIf(process.platform !== "win32")(
    `managed producer ${mode} joins actual native ownership`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-managed-source-"))
      const child = Bun.spawn([process.execPath, "tests/fixtures/managed-source.ts", mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        windowsHide: true,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          LOCALAPPDATA: path.join(root, "local"),
          KILO_TEST_HOME: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          RAYA_DB: ":memory:",
          KILO_DB: ":memory:",
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
        await Bun.write(path.join(root, "stdout.log"), stdout)
        await Bun.write(path.join(root, "stderr.log"), stderr)
        expect(code, `Retained actual fixture ${root}: ${stderr}`).toBe(0)
        expect(JSON.parse(stdout)).toMatchObject(
          mode === "natural"
            ? { passed: true, sourceExit: 0, familyExit: 0, portable: false }
            : { passed: true, mode, portable: false },
        )
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
    25000,
  )
