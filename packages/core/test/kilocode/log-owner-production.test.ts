import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"

for (const mode of ["unused", "success", "failure"]) {
  test(`isolated production logger ${mode}`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/log-owner-production.ts"), tmp.path, mode],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill(), 10000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).not.toContain("AssertionError")
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ mode, passed: true })
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  }, 15000)
}
