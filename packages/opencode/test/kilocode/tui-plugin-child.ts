import { expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export async function plugin(mode: string) {
  const root = await mkdtemp(path.join(tmpdir(), "raya-plugin-retirement-"))
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/tui-plugin-retirement.ts")],
    {
      env: {
        ...process.env,
        RAYA_PLUGIN_CASE: mode,
        RAYA_PLUGIN_PROFILE: root,
        KILO_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        KILO_PLUGIN_META_FILE: path.join(root, "plugin-meta.json"),
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        RAYA_NO_DAEMON: "1",
        KILO_NO_DAEMON: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `Retained profile: ${root}\n${stderr}`).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ mode, passed: true })
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
  }
}
