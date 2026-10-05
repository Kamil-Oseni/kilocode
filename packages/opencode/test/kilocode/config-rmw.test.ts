import { test, expect } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const mode of [
  "mixed",
  "setup",
  "maintenance",
  "rebind",
  "safe",
  "partial",
  "console",
  "legacy",
  "seed",
  "bash",
  "stale",
  "layered",
  "project",
  "lock",
  "account",
  ...(process.platform === "win32" ? ["account-default"] : []),
]) {
  test(`actual common configuration RMW ${mode}`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/config-rmw.ts"), tmp.path, mode],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(SystemRoot|WINDIR|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|PSModulePath)$/i.test(name),
          ),
        ),
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, err).toBe(0)
    const result = JSON.parse(out)
    expect(result.mode).toBe(mode)
    expect(result.terminal).toBe(true)
    expect(result.results.length).toBeGreaterThanOrEqual(2)
  }, 30000)
}
