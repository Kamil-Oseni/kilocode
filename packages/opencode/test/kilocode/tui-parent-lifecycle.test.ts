import { expect, test } from "bun:test"
import { join } from "node:path"
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

for (const mode of ["SIGINT", "SIGTERM", "SIGHUP", "publication", "failure", "combined", "startup"])
  test(`TUI parent joins renderer scope before real worker stop: ${mode}`, async () => {
    const dir = { path: mkdtempSync(join(tmpdir(), "raya-tui-parent-")) }
    const state = { forced: false }
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./fixtures/tui-parent-lifecycle.ts", import.meta.url)), dir.path, mode],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          KILO_TEST_HOME: dir.path,
          XDG_DATA_HOME: join(dir.path, "data"),
          XDG_CONFIG_HOME: join(dir.path, "config"),
          XDG_STATE_HOME: join(dir.path, "state"),
          XDG_CACHE_HOME: join(dir.path, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const timer = setTimeout(() => {
      state.forced = true
      child.kill()
    }, 15_000)
    const identity =
      process.platform === "win32"
        ? Bun.spawnSync(
            [
              "powershell",
              "-NoProfile",
              "-Command",
              `Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath | ConvertTo-Json -Compress`,
            ],
            { windowsHide: true },
          )
        : undefined
    const metadata = identity?.stdout.toString().trim()
    writeFileSync(
      join(dir.path, "identity.json"),
      JSON.stringify({
        pid: child.pid,
        native: metadata ? JSON.parse(metadata) : undefined,
        executable: process.execPath,
        sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      }),
    )
    writeFileSync(join(dir.path, "release"), "admitted")
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      writeFileSync(join(dir.path, "host.stdout"), stdout)
      writeFileSync(join(dir.path, "host.stderr"), stderr)
      writeFileSync(join(dir.path, "host.json"), JSON.stringify({ mode, pid: child.pid, code, forced: state.forced }))
      expect(state.forced).toBe(false)
      expect(() => process.kill(child.pid, 0)).toThrow()
      if (process.platform === "win32") {
        const absent = Bun.spawnSync(
          [
            "powershell",
            "-NoProfile",
            "-Command",
            `@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq ${child.pid} } | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress`,
          ],
          { windowsHide: true },
        )
        expect(absent.exitCode).toBe(0)
        expect(absent.stdout.toString().trim()).toBe("")
        expect(JSON.parse(metadata!).ProcessId).toBe(child.pid)
      }
      expect(stderr).toBe("")
      expect(code).toBe(mode === "SIGTERM" ? 143 : mode === "SIGHUP" ? 129 : mode === "startup" ? 1 : 130)
      const line = stdout.trim().split("\n").at(-1)!
      expect(JSON.parse(line).ok).toBe(true)
      expect(JSON.parse(line).counts).toEqual({
        shutdown: 1,
        close: mode === "startup" ? 0 : 1,
        disposed: 1,
        upgrade: 0,
      })
      if (mode !== "startup") expect(readFileSync(join(dir.path, "renderer.txt"), "utf8")).toBe("scope-finalized\n")
    } finally {
      clearTimeout(timer)
      await child.exited
      expect(() => process.kill(child.pid, 0)).toThrow()
    }
  }, 20_000)
