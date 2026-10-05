import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["owned", "unowned"])
  test(`actual config HTTP ${mode} rewrite preserves current binding and original history`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-config-owned-write-"))
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(?:RAYA_|KILO_|OPENCODE_|OTEL_)/i.test(key) || /API_KEY|TOKEN|SECRET/i.test(key)) delete env[key]
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      KILO_TEST_HOME: root,
      KILO_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      KILO_CONFIG: path.join(root, "explicit.json"),
      KILO_DB: path.join(root, "data/kilo/raya.db"),
      RAYA_DB: path.join(root, "data/kilo/raya.db"),
      KILO_AUTH_CONTENT: "{}",
      RAYA_AUTH_CONTENT: "{}",
      KILO_DISABLE_DEFAULT_PLUGINS: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_VSCODE: "1",
    })
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/config-owned-write.ts"),
        root,
        mode,
      ],
      { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      child.kill()
    }, 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await Promise.all([
        writeFile(path.join(root, "stdout.log"), stdout),
        writeFile(path.join(root, "stderr.log"), stderr),
      ])
      expect(forced, root).toBe(false)
      expect(code, `${root}: ${stderr}`).toBe(0)
      expect(stdout).toContain(
        mode === "owned" ? "CONFIG_OWNED_WRITE_CURRENT_AND_HISTORY_VERIFIED" : "CONFIG_UNOWNED_REWRITE_REFUSED",
      )
    } finally {
      clearTimeout(timer)
    }
  }, 50000)
