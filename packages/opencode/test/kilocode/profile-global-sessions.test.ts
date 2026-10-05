import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { withTimeout } from "../../src/util/timeout"

test("actual non-Git source session remains visible after encrypted mapped restore and two runtime starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-global-session-"))
  for (const name of ["old", "new", "source", "restore", "restart"])
    await mkdir(path.join(root, name, "nested"), { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(?:OTEL_|KILO_|RAYA_|OPENCODE_)|(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  const home = (name: string) => {
    const directory = path.join(root, name)
    return {
      HOME: directory,
      USERPROFILE: directory,
      LOCALAPPDATA: path.join(directory, "local"),
      KILO_TEST_HOME: directory,
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
      RAYA_DB: path.join(directory, "raya.db"),
      KILO_DB: path.join(directory, "raya.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_CONFIG_CONTENT: '{"enabled_providers":[]}',
      KILO_PURE: "1",
    }
  }
  const run = async (mode: string, overrides: NodeJS.ProcessEnv) => {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/profile-global-sessions.ts"), root, mode],
      { env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, output, errors]),
        45000,
        `Global session fixture retained at ${root}`,
      )
      await writeFile(path.join(root, `${mode}-stderr.log`), stderr)
      assert.equal(code, 0, stderr)
      expect(stdout).toContain(`GLOBAL_SESSION_${mode}_PASS`)
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await writeFile(path.join(root, `${mode}-stderr.log`), await errors)
      await output
    }
  }
  await run("source", home("source"))
  await run("compat", home("compat"))
  await run("restore", home("restore"))
  const parsed: unknown = JSON.parse(await readFile(path.join(root, "restored.json"), "utf8"))
  assert.ok(parsed && typeof parsed === "object" && "env" in parsed && parsed.env && typeof parsed.env === "object")
  await run("restart", { ...home("restart"), ...parsed.env })
  await run("restart", { ...home("restart"), ...parsed.env })
}, 150000)
