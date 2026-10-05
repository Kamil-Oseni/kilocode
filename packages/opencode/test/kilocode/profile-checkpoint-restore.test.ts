import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform !== "win32")(
  "encrypted named checkpoint retains its real Git tree and fresh restored checkpoint API",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-checkpoint-restore-"))
    const env = { ...process.env }
    for (const name of Object.keys(env))
      if (
        name.startsWith("RAYA_SOURCE_") ||
        name.startsWith("RAYA_DAEMON_") ||
        name.startsWith("OTEL_") ||
        /(API_KEY|TOKEN|SECRET)$/.test(name)
      )
        delete env[name]
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      KILO_TEST_HOME: path.join(root, "home"),
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      RAYA_DB: path.join(root, "unused.db"),
      KILO_DB: path.join(root, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      RAYA_DISABLE_AUTOUPDATE: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
    })
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/profile-checkpoint-restore.ts"), root],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const timeout = setTimeout(() => child.kill(), 60_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timeout)
    if (code !== 0) console.error(`Retained checkpoint restore ${root}: ${stderr}`)
    expect(code).toBe(0)
    expect(stdout).toContain("CHECKPOINT_RESTORE_OK")
    expect(stdout).toContain("CHECKPOINT_LONG_PACK_OK")
    expect(() => process.kill(child.pid, 0)).toThrow()
  },
  65_000,
)
