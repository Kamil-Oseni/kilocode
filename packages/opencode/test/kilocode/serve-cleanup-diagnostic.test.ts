import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual TCP Serve cleanup emits only bounded nested fixed classifications and retains native refusal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-serve-diagnostic-"))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(key) && !/(TOKEN|SECRET|API_KEY)$/.test(key),
    ),
  )
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    KILO_TEST_HOME: root,
    LOCALAPPDATA: path.join(root, "local"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    RAYA_DB: path.join(root, "unused.db"),
    KILO_DB: path.join(root, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_MODELS_FETCH: "1",
  })
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "test/kilocode/fixtures/serve-cleanup-diagnostic.ts", root],
    { cwd: path.resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  const timer = setTimeout(() => child.kill("SIGKILL"), 25000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `Retained ${root}: ${stderr}`).toBe(1)
    expect(stdout).toContain("SERVE_DIAGNOSTIC_NATIVE_PASS")
    const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith("RAYA_SERVE_CLEANUP_FAILURE "))
    expect(lines).toHaveLength(1)
    const value = JSON.parse(lines[0].slice("RAYA_SERVE_CLEANUP_FAILURE ".length))
    expect(value.format).toBe("raya.source-failure")
    expect(value.errors.some((item: { code?: string }) => item.code === "RAYA_SERVE_HTTP_DRAIN_FAILED")).toBe(true)
    expect(value.errors.some((item: { code?: string }) => item.code === "EBADF")).toBe(true)
    expect(stderr).not.toContain("PRIVATE_CLEANUP_PASSWORD_AND_PATH")
    expect(lines[0]).not.toContain(root)
    expect(lines[0].length).toBeLessThan(16000)
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 30000)
