import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../src/util/timeout"

async function child(mode: string, held?: (pid: number, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "raya-outer-exit-"))
  const db = join(root, "raya.db")
  const parent =
    mode === "serve-orphan"
      ? Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
      : undefined
  if (parent) expect(await parent.exited).toBe(0)
  const proc = Bun.spawn([process.execPath, "--conditions=browser", join(import.meta.dir, "outer-exit.fixture.ts")], {
    cwd: resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      RAYA_EXIT_CASE: mode,
      RAYA_EXIT_PROFILE: root,
      HOME: root,
      USERPROFILE: root,
      KILO_TEST_HOME: root,
      LOCALAPPDATA: join(root, "local"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      RAYA_DB: db,
      KILO_DB: db,
      KILO_PARENT_PID: parent ? String(parent.pid) : undefined,
      RAYA_NO_DAEMON: "1",
      KILO_NO_DAEMON: "1",
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_CONFIG_CONTENT:
        '{"formatter":false,"lsp":false,"permission":"deny","enabled_providers":[],"experimental":{"openTelemetry":false}}',
      KILO_AUTH_CONTENT: "{}",
      RAYA_AUTH_CONTENT: "{}",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const streams = [new Response(proc.stdout).text(), new Response(proc.stderr).text()]
  try {
    if (held) await held(proc.pid, root)
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([proc.exited, ...streams]),
      45_000,
      `Outer exit timed out; profile retained: ${root}`,
    )
    await Bun.write(join(root, "stdout.log"), stdout)
    await Bun.write(join(root, "stderr.log"), stderr)
    const receipt = await Bun.file(join(root, "finalizer.json")).json()
    const log = (await Bun.file(join(root, "log-path")).exists())
      ? await Bun.file(await Bun.file(join(root, "log-path")).text()).text()
      : undefined
    return { code, stdout, stderr, receipt, database: await Bun.file(db).exists(), log }
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL")
    const [, stdout, stderr] = await withTimeout(
      Promise.all([proc.exited, ...streams]),
      10_000,
      "Exit child did not join",
    )
    await Bun.write(join(root, "stdout.log"), stdout)
    await Bun.write(join(root, "stderr.log"), stderr)
    const absent = (() => {
      try {
        process.kill(proc.pid, 0)
        return false
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
        throw err
      }
    })()
    await Bun.write(join(root, "cleanup.json"), JSON.stringify({ pid: proc.pid, absent }))
    expect(absent, `Child remains; retained profile: ${root}`).toBe(true)
  }
}

test("outer exit waits for a real held finalizer before terminating", async () => {
  const result = await child("held", async (pid, root) => {
    const deadline = performance.now() + 20_000
    while (!(await Bun.file(join(root, "waiting")).exists())) {
      if (performance.now() >= deadline) throw new Error("Held finalizer never entered")
      await Bun.sleep(10)
    }
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(await Bun.file(join(root, "finalizer.json")).exists()).toBe(false)
    await Bun.write(join(root, "release"), "release")
  })
  expect(result.code).toBe(0)
  expect(result.receipt).toEqual({ code: 0, mode: "held", settled: true })
}, 60_000)

for (const mode of ["command", "cleanup", "both"])
  test(`production CLI ${mode} failure retires owners and explicitly exits nonzero`, async () => {
    const result = await child(mode)
    expect(result.code, result.stderr).toBe(1)
    expect(result.receipt.settled).toBe(true)
    if (mode !== "cleanup") expect(result.receipt.code).toBe(1)
    if (mode !== "command") expect(result.stderr).toContain("outer exit finalizer failed")
    if (mode !== "cleanup") expect(result.stderr).toContain("raya_missing_outer_exit_table")
  }, 60_000)

test("production help retires registered owners without opening an unused database", async () => {
  const result = await child("help")
  expect(result.code, result.stderr).toBe(0)
  expect(result.receipt).toEqual({ code: 0, mode: "help", settled: true })
  expect(result.database).toBe(false)
}, 60_000)

test("an exited configured client retires the real server and persists its final log", async () => {
  const result = await child("serve-orphan")
  expect(result.stdout).toContain("kilo server listening on http://127.0.0.1:")
  expect(result.code, result.stderr).toBe(0)
  expect(result.receipt).toEqual({ code: 0, mode: "serve-orphan", settled: true })
  expect(result.log).toContain("RAYA_OUTER_FINALIZER_LAST_MARKER")
}, 60_000)

test("failed retirement preserves an existing nonzero process exit status", async () => {
  const result = await child("status")
  expect(result.code).toBe(7)
  expect(result.receipt).toEqual({ code: 7, mode: "status", settled: true })
  expect(result.stderr).toContain("outer exit finalizer failed")
}, 60_000)

for (const mode of ["log", "log-cleanup", "effect-log", "effect-log-cleanup"])
  test(`production ${mode} exit persists the last runtime finalizer log before terminating`, async () => {
    const result = await child(mode)
    expect(result.code, result.stderr).toBe(mode.endsWith("cleanup") ? 1 : 0)
    expect(result.log).toContain("RAYA_OUTER_FINALIZER_LAST_MARKER")
    if (mode.endsWith("cleanup")) expect(result.stderr).toContain("outer exit finalizer failed")
  }, 60_000)

for (const mode of ["publish", "publish-cleanup", "publish-throw"])
  test(`completion ${mode} only publishes after successful retirement`, async () => {
    const result = await child(mode)
    expect(result.code, result.stderr).toBe(mode === "publish" ? 0 : 1)
    expect(result.receipt.settled).toBe(true)
    expect(result.stdout.includes("RAYA_RETIREMENT_PUBLICATION")).toBe(mode === "publish")
    if (mode === "publish-throw") {
      expect(result.stderr).toContain("Raya completion publication failed.")
      expect(result.stderr).not.toContain("RAYA_PRIVATE_PUBLICATION_ERROR")
    }
  }, 60_000)
