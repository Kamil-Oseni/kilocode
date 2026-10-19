import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { remove } from "./cleanup"

test("original stopped report survives an inbox fault and two real process reopens without replaying work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-stop-report-crash-"))
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  const password = crypto.randomUUID()
  const fixture = path.join(import.meta.dir, "fixtures", "task-stop-report-crash.ts")
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PSModulePath", "SystemDrive"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]!]),
  )
  const state = { complete: false }
  const epochs: Array<{ pid: number; birth: string }> = []
  try {
    for (const mode of ["fault", "cold", "recover"] as const) {
      const child = Bun.spawn([process.execPath, "--conditions=browser", fixture, root, mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...env,
          HOME: path.join(root, "home"),
          USERPROFILE: path.join(root, "home"),
          APPDATA: path.join(root, "roaming"),
          LOCALAPPDATA: path.join(root, "local"),
          TEMP: path.join(root, "tmp"),
          TMP: path.join(root, "tmp"),
          KILO_TEST_HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_RUNTIME_DIR: path.join(root, "runtime"),
          RAYA_DB: path.join(root, "runtime.sqlite"),
          KILO_CONFIG_CONTENT: JSON.stringify({
            formatter: false,
            lsp: false,
            enabled_providers: [],
            permission: { "*": "deny" },
          }),
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_PURE: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_DISABLE_AUTOCOMPACT: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          RAYA_DISABLE_MODELS_FETCH: "1",
          KILO_AUTH_CONTENT: "{}",
          KILO_PRINT_LOGS: "1",
          KILO_SERVER_PASSWORD: password,
          KILO_NO_DAEMON: "1",
          RAYA_NO_DAEMON: "1",
        },
      })
      const sizes = { stdout: 0, stderr: 0 }
      const captured = { stdout: "", stderr: "" }
      const read = async (stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") => {
        const reader = stream.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const row = await reader.read()
            if (row.done) {
              return Buffer.concat(chunks).toString("utf8")
            }
            bytes += row.value.byteLength
            sizes[kind] = bytes
            if (bytes <= 2 * 1024 * 1024) chunks.push(row.value)
          }
        } finally {
          captured[kind] = Buffer.concat(chunks).toString("utf8")
          reader.releaseLock()
        }
      }
      const deadline = { fired: false }
      const timer = setTimeout(() => {
        deadline.fired = true
        child.kill()
      }, 30_000)
      // A failed reader cannot disarm the original process deadline or skip joins.
      const [stdout, stderr, exit] = await Promise.allSettled([
        read(child.stdout, "stdout"),
        read(child.stderr, "stderr"),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      for (const kind of ["stdout", "stderr"] as const)
        await fs.writeFile(path.join(root, `${mode}.${kind}.log`), captured[kind], { flag: "wx" })
      if (stdout.status === "rejected" || stderr.status === "rejected" || exit.status === "rejected")
        throw new AggregateError(
          [stdout, stderr, exit].flatMap((row) => (row.status === "rejected" ? [row.reason] : [])),
          "Original child and both readers settled with failure",
        )
      expect(deadline.fired).toBe(false)
      expect(sizes.stdout).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(sizes.stderr).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(exit.value, stderr.value).toBe(mode === "fault" ? 86 : 0)
      expect(child.signalCode).toBeNull()
      const epoch = JSON.parse(await fs.readFile(path.join(root, `${mode}-epoch.json`), "utf8")) as {
        pid: number
        birth: string
      }
      // Bind the child-observed OS birth to the exact handle whose exit was joined.
      // This is not a separate parent-side OS creation-time probe.
      expect(epoch.pid).toBe(child.pid)
      expect(typeof epoch.birth).toBe("string")
      if (process.platform === "win32") {
        expect(epoch.birth).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/)
        expect(Number.isFinite(Date.parse(epoch.birth))).toBe(true)
      }
      if (process.platform === "linux")
        expect(epoch.birth).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(?:0|[1-9]\d*)$/)
      epochs.push(epoch)
      expect(stdout.value).toContain(`STOP_REPORT_CRASH_${mode.toUpperCase()}_VERIFIED`)
      if (mode === "fault") {
        const diagnostic = JSON.parse(await fs.readFile(path.join(root, "fault-http.json"), "utf8")) as {
          status: number
          response: { data: { code: string; ref: string } }
        }
        expect(diagnostic.status).toBe(500)
        expect(diagnostic.response.data.code).toBe("server.unexpected")
        expect(diagnostic.response.data.ref).toMatch(/^err_[a-f0-9]{8}$/)
        // The actual middleware diagnostic must bind this original HTTP failure
        // to SQLite's trigger error. A configured trigger and cut state are insufficient.
        expect(
          stderr.value
            .split("\n")
            .some(
              (line) =>
                line.includes(`ref=${diagnostic.response.data.ref}`) &&
                line.includes("original stopped inbox insertion fault"),
            ),
        ).toBe(true)
      }
      if (mode !== "fault") expect(stdout.value).toContain("STOP_REPORT_CRASH_OWNERS_CLOSED")
    }
    // Each child has its own process identity; no in-memory completion map survives.
    expect(epochs).toHaveLength(3)
    expect(new Set(epochs.map((row) => `${row.pid}:${row.birth}`)).size).toBe(3)
    state.complete = true
  } finally {
    // The target is the exact original mkdtemp child, never a supplied profile.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert(path.basename(root).startsWith("raya-stop-report-crash-"))
    if (state.complete) await remove(root)
    else console.error("STOP_REPORT_CRASH_EVIDENCE_RETAINED", root)
  }
}, 120_000)
