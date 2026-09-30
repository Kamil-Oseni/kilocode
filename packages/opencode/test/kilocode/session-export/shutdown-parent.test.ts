import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

for (const mode of ["wrong", "timeout", "capture"] as const)
  test(`session export parent refuses ${mode} shutdown acknowledgement and fences restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-export-shutdown-parent-"))
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      KILO_TEST_HOME: root,
    }
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", resolve(import.meta.dir, "fixtures/shutdown-parent.ts"), mode],
      {
        cwd: resolve(import.meta.dir, "../../.."),
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const code = await child.exited
      const [stdout, stderr] = await output
      expect(code, stdout + stderr).toBe(0)
      expect(stdout).toContain(`"mode":"${mode}"`)
      expect(stdout).toContain('"terminated":true')
      if (mode === "capture") expect(stdout).toContain('"posts":0')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await output
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)
