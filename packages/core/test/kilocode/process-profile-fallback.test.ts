import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

for (const mode of ["parent", "preferred", "explicit"]) {
  test(`actual managed Global import retains safe ${mode} state fallback semantics`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-profile-fallback-"))
    const child = Bun.spawn([process.execPath, "test/kilocode/fixture/process-profile-fallback.ts", mode], {
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
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: mode === "explicit" ? path.join(root, "explicit") : "",
        RAYA_DB: path.join(root, "unused.db"),
      },
    })
    const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
      await Bun.write(path.join(root, "stdout.log"), stdout)
      await Bun.write(path.join(root, "stderr.log"), stderr)
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ passed: true, mode })
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }, 20000)
}
