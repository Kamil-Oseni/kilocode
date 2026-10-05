import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["normal", "download", "refuse", "expiry", "pipe", "alias", "expanded", "foreign"])
  test(`actual managed Lua installation and original client retirement: ${mode}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-lsp-owned-"))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/lsp-owned.ts"), mode], {
      cwd: path.resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        RAYA_LSP_OWNED_ROOT: dir,
        HOME: dir,
        KILO_TEST_HOME: dir,
        XDG_DATA_HOME: path.join(dir, "data"),
        XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_CACHE_HOME: path.join(dir, "cache"),
        KILO_DISABLE_MODELS_FETCH: "true",
        KILO_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
        KILO_TEST_MANAGED_CONFIG_DIR: path.join(dir, "managed"),
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_DB: ":memory:",
      },
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const code = await child.exited
    await fs.writeFile(
      path.join(dir, "retained.json"),
      JSON.stringify({ pid: child.pid, code, forced: false, stdout: await stdout, stderr: await stderr }),
    )
    expect(code, await stderr).toBe(0)
    expect(await stdout).toContain('"passed":true')
  }, 60_000)
