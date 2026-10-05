import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../../src/util/timeout"

// The production handler cache is terminal. Exercise it in another process so
// retirement cannot invalidate the parent test runner's shared service graph.
test("production cached HTTP handler refuses dispatch during and after retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-http-retirement-test-"))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "http-retirement.fixture.ts")], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      RAYA_RETIREMENT_PROFILE: root,
      HOME: root,
      KILO_TEST_HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      RAYA_DB: join(root, "raya.db"),
      RAYA_NO_DAEMON: "1",
      KILO_NO_DAEMON: "1",
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_CONFIG_CONTENT: '{"formatter":false,"lsp":false,"permission":"deny","enabled_providers":[]}',
      KILO_AUTH_CONTENT: "{}",
      KILO_SERVER_PASSWORD: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  try {
    const [exit, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, ...streams]),
      45_000,
      `HTTP retirement child timed out; retained profile: ${root}`,
    )
    await Bun.write(join(root, "stdout.log"), stdout)
    await Bun.write(join(root, "stderr.log"), stderr)
    expect(exit, `Profile retained at ${root}; stderr: ${stderr}`).toBe(0)
    const receipt = await Bun.file(join(root, "receipt.json")).json()
    expect(receipt).toEqual({ passed: true, pid: child.pid, cached: true, joined: true, pending: true, terminal: true })
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    const [, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, ...streams]),
      10_000,
      `Owned child did not join: ${root}`,
    )
    await Bun.write(join(root, "stdout.log"), stdout)
    await Bun.write(join(root, "stderr.log"), stderr)
    const absent = (() => {
      try {
        process.kill(child.pid, 0)
        return false
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
        throw err
      }
    })()
    await Bun.write(join(root, "cleanup.json"), JSON.stringify({ pid: child.pid, absent }))
    expect(absent, `Owned child remains live; profile: ${root}`).toBe(true)
  }
}, 60_000)
