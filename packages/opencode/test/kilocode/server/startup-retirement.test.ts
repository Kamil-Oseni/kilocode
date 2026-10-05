import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { withTimeout } from "@/util/timeout"

test("cold standalone HTTP initialization joins retirement before native database closure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-cold-startup-retirement-"))
  await mkdir(path.join(root, "workspace"))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !/^(?:RAYA|KILO|OPENCODE|OTEL|GIT)_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key),
    ),
  )
  Object.assign(env, {
    RAYA_RETIREMENT_PROFILE: root,
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
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "startup-retirement.fixture.ts")], {
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
      45_000,
      `Retained profile: ${root}`,
    )
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `Retained profile: ${root}\n${stderr}`).toBe(0)
    expect(await Bun.file(path.join(root, "receipt.json")).json()).toEqual({ passed: true, pid: child.pid })
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 55_000)

for (const mode of ["unused", "held"]) {
  test(`runtime initialization retirement preserves ${mode} ownership`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-owned-startup-"))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          !/^(?:RAYA|KILO|OPENCODE|OTEL|GIT)_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key),
      ),
    )
    Object.assign(env, {
      RAYA_RETIREMENT_PROFILE: root,
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
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
    })
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "startup-runtime.fixture.ts"), mode], {
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
        20_000,
        `Retained profile: ${root}`,
      )
      await Bun.write(path.join(root, "stdout.log"), stdout)
      await Bun.write(path.join(root, "stderr.log"), stderr)
      expect(code, `Retained profile: ${root}\n${stderr}`).toBe(0)
      expect(stdout).toContain(JSON.stringify({ passed: true, mode }))
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }, 25_000)
}
