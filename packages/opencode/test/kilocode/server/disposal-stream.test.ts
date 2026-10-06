import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../../src/util/timeout"

test("production listener delivers original instance disposal before forced socket retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-disposal-stream-"))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "disposal-stream.fixture.ts")], {
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
  const [exit, stdout, stderr] = await withTimeout(
    Promise.all([child.exited, ...streams]),
    45_000,
    `Original child still owned: ${root}`,
  )
  await Bun.write(join(root, "stdout.log"), stdout)
  await Bun.write(join(root, "stderr.log"), stderr)
  expect(exit, `Retained profile: ${root}; stderr: ${stderr}`).toBe(0)
  const receipt = await Bun.file(join(root, "receipt.json")).json()
  expect(receipt.passed).toBe(true)
  expect(receipt.originalStreamJoined).toBe(true)
  expect(receipt.events[0]).toBe("server.connected")
  expect(receipt.events.at(-1)).toBe("server.instance.disposed")
  expect(receipt.events.filter((event: string) => event === "server.instance.disposed")).toHaveLength(1)
  expect(receipt.events).not.toContain("server.resync_required")
}, 60_000)
