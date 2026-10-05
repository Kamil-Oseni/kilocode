import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { withTimeout } from "../../src/util/timeout"

for (const mode of ["success", "failed"])
  test(`actual isolated LSP joins canceled startup and retains registry failure: ${mode}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-lsp-retirement-"))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/lsp-startup-service.ts"), mode], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: dir,
        KILO_TEST_HOME: dir,
        KILO_TEST_MANAGED_CONFIG_DIR: path.join(dir, "managed"),
        KILO_DISABLE_MODELS_FETCH: "true",
        KILO_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_DB: ":memory:",
        XDG_DATA_HOME: path.join(dir, "data"),
        XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_CACHE_HOME: path.join(dir, "cache"),
      },
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      expect(await withTimeout(child.exited, 15_000, "Isolated LSP retirement did not settle"), await stderr).toBe(0)
      expect(await stdout).toContain(`"mode":"${mode}"`)
      expect(await stdout).toContain(`"registryRefused":${mode === "failed"}`)
      await fs.rm(dir, { recursive: true, force: true })
    } catch (err) {
      await fs.writeFile(path.join(dir, "failure.txt"), String(err))
      console.error(`Retained isolated LSP retirement: ${dir}`)
      throw err
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      if (
        await fs.stat(dir).then(
          () => true,
          () => false,
        )
      )
        await fs.writeFile(
          path.join(dir, "child.json"),
          JSON.stringify({ pid: child.pid, code: child.exitCode, stdout: await stdout, stderr: await stderr }),
        )
    }
  }, 20_000)
