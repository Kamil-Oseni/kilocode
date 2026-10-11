import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir as temporary } from "node:os"
import path from "node:path"
import { withTimeout } from "@/util/timeout"
import { tmpdir } from "../../fixture/fixture"

test("routine organization HTTP persists ordered graphs with optimistic archive lifecycle", async () => {
  await using directory = await tmpdir({ git: true })
  const root = await mkdtemp(path.join(temporary(), "raya-organization-http-"))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !/^(?:RAYA|KILO|OPENCODE|OTEL|GIT)_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key),
    ),
  )
  Object.assign(env, {
    RAYA_ORGANIZATION_PROFILE: root,
    RAYA_ORGANIZATION_WORKSPACE: directory.path,
    HOME: root,
    USERPROFILE: root,
    KILO_TEST_HOME: root,
    LOCALAPPDATA: path.join(root, "local"),
    APPDATA: path.join(root, "roaming"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    RAYA_DB: path.join(root, "raya.db"),
    KILO_DB: path.join(root, "raya.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_PURE: "1",
    KILO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false, permission: "deny", enabled_providers: [] }),
  })
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "httpapi-routine-organization.fixture.ts")], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  try {
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, output, errors]),
      90_000,
      `Retained profile: ${root}`,
    )
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `Retained profile: ${root}\n${stderr}`).toBe(0)
    expect(await Bun.file(path.join(root, "receipt.json")).json()).toEqual({
      passed: true,
      pid: child.pid,
      physical: path.join(root, "raya.db"),
    })
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 100_000)
