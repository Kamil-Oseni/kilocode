import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("three real Workers carry actual Global roles through exact production ACK codecs and reject foreign/legacy export scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-global-scopes-"))
  await mkdir(path.join(root, "home"))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(KILO|RAYA|OTEL|OPENCODE)_|API_KEY|TOKEN|SECRET|PASSWORD/i.test(key),
    ),
  )
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/global-scopes.ts"), root], {
    windowsHide: true,
    env: {
      ...env,
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      KILO_TEST_HOME: path.join(root, "home"),
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      RAYA_DB: path.join(root, "unused.db"),
      KILO_DB: path.join(root, "unused.db"),
      KILO_AUTH_CONTENT: "{}",
      RAYA_AUTH_CONTENT: "{}",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const state = { forced: false }
  const timer = setTimeout(() => {
    state.forced = true
    child.kill()
  }, 30000)
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await writeFile(path.join(root, "stdout.log"), out)
    await writeFile(path.join(root, "stderr.log"), err)
    expect(state.forced).toBe(false)
    expect(code, `Retained ${root}: ${err}`).toBe(0)
    expect(JSON.parse(out)).toMatchObject({
      passed: true,
      confirmed: 3,
      completeProfileCoverage: false,
      portable: false,
    })
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 40000)
