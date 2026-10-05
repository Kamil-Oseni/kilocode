import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["v1", "v1-virtual"] as const)
  test(`actual controller config ${mode} preserves required origin classification`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-controller-config-"))
    const env = { ...process.env }
    for (const field of Object.keys(env))
      if (/^(?:RAYA_|KILO_|OPENCODE_|OTEL_)/i.test(field) || /API_KEY|TOKEN|SECRET/i.test(field)) delete env[field]
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
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
    if (mode === "v1-virtual") env.KILO_CONFIG_CONTENT = '{"model":"provider/virtual"}'
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/controller-config-origin.ts"),
        root,
        mode,
      ],
      {
        env,
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      child.kill()
    }, 45_000)
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
      if (mode === "v1") {
        expect(stdout).toContain("CONTROLLER_CONFIG_PHYSICAL_COMPLETE")
        expect(stderr).not.toContain("RAYA_SOURCE_SCOPE_FAILURE")
        return
      }
      expect(stdout).toContain("CONTROLLER_CONFIG_VIRTUAL_REFUSED")
      const line = stderr.split(/\r?\n/).find((line) => line.startsWith("RAYA_SOURCE_SCOPE_FAILURE "))
      expect(line).toBeDefined()
      const value = JSON.parse(line!.slice("RAYA_SOURCE_SCOPE_FAILURE ".length))
      expect(value).toEqual({
        code: "RAYA_SOURCE_SCOPE_INCOMPLETE",
        scopes: [
          {
            role: "source",
            version: 4,
            configStatus: "uncertain",
            configReason: "origin-uncertain",
            globalCount: 1,
          },
        ],
        omitted: 0,
      })
      expect(line).not.toContain(root)
      expect(line).not.toContain("provider/virtual")
    } finally {
      clearTimeout(timer)
    }
  }, 50_000)
