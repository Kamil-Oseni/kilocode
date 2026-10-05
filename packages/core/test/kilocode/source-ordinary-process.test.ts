import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["ordinary", "legacy", "failure", "forced", "rejected", "changed"])
  test.skipIf(process.platform !== "win32")(
    `ordinary source retirement ${mode} retains physical and diagnostic evidence`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-ordinary-"))
      const local = await mkdtemp(path.join(os.tmpdir(), "raya-source-ordinary-registry-"))
      const child = Bun.spawn([process.execPath, "test/kilocode/fixtures/source-ordinary.ts", mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          KILO_TEST_HOME: root,
          LOCALAPPDATA: local,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          RAYA_DB: path.join(root, "unused.db"),
          KILO_DB: path.join(root, "unused.db"),
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
          RAYA_SOURCE_ORDINARY_ROOT: root,
        },
      })
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      const timer = setTimeout(() => child.kill("SIGKILL"), 55000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
        await Bun.write(path.join(root, "parent.stdout.log"), stdout)
        await Bun.write(path.join(root, "parent.stderr.log"), stderr)
        expect(code, `Retained ${root}: ${stderr}`).toBe(0)
        const receipt = await Bun.file(path.join(root, "receipt.json")).json()
        expect(receipt.passed).toBe(true)
        expect(receipt.absence.every((value: { absent: boolean }) => value.absent)).toBe(true)
        expect(receipt.portableCaptureAuthorized).toBe(false)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
    60000,
  )
