import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

for (const mode of ["clean", "held", "failed"]) {
  test(`actual indexing graph ${mode} cleanup joins ACK and clean exit or retains refusal`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-index-retirement-"))
    const child = Bun.spawn([process.execPath, "test/kilocode/fixtures/indexing-retirement.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        RAYA_DB: path.join(root, "unused.db"),
        RAYA_INDEXING_TEST_ROOT: root,
        RAYA_INDEXING_TEST_MODE: mode,
      },
    })
    const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
      await Bun.write(path.join(root, "stdout.log"), stdout)
      await Bun.write(path.join(root, "stderr.log"), stderr)
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
        passed: true,
        mode,
        portable: false,
      })
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }, 30000)
}
