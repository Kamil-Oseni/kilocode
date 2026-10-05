import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { project } from "../../src/kilocode/config-intent"

test("safe config intent excludes secrets, substitutions and executable fields with a typed ledger", () => {
  const value = project(
    JSON.stringify({
      model: "qwen-local/qwen3-raya-32k",
      default_agent: "auto",
      provider: {
        local: {
          options: { apiKey: "SYNTHETIC_SECRET_SENTINEL" },
          headers: { Authorization: "SYNTHETIC_SECRET_SENTINEL" },
        },
      },
      mcp: { x: { environment: { TOKEN: "SYNTHETIC_SECRET_SENTINEL" } } },
      permission: "allow",
      plugin: ["file:///unsafe.js"],
      small_model: "{env:SECRET}",
      commands: { note: { template: "café 日本語 😀" } },
    }),
  )
  expect(value.safe).toEqual({ model: "qwen-local/qwen3-raya-32k", default_agent: "auto" })
  expect(value.excluded).toEqual([
    { field: "provider", reason: "credential-or-execution" },
    { field: "mcp", reason: "credential-or-execution" },
    { field: "permission", reason: "credential-or-execution" },
    { field: "plugin", reason: "credential-or-execution" },
    { field: "small_model", reason: "substitution" },
    { field: "commands", reason: "credential-or-execution" },
  ])
  expect(JSON.stringify(value)).not.toContain("SYNTHETIC_SECRET_SENTINEL")
  expect(project('{"unknown":{"private":"excluded"}}').excluded).toEqual([{ field: "unknown", reason: "unsupported" }])
})

for (const mode of [
  "v1",
  "v1-schema",
  "v1-schema-refused",
  "v2",
  "v2-two",
  "v2-unknown",
  "v2-alias",
  "v1-virtual",
  "lifecycle",
])
  test(`actual ${mode} config loader retains its own document order, physical origins and late-change refusal`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-config-intent-"))
    const env = { ...process.env }
    for (const field of Object.keys(env))
      if (/^(?:RAYA_|KILO_|OPENCODE_|OTEL_)/i.test(field) || /API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/i.test(field))
        delete env[field]
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      KILO_TEST_HOME: root,
      KILO_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      KILO_CONFIG: path.join(root, "explicit.json"),
      KILO_DB: path.join(root, "data", "kilo", "raya.db"),
      RAYA_DB: path.join(root, "data", "kilo", "raya.db"),
      KILO_AUTH_CONTENT: "{}",
      RAYA_AUTH_CONTENT: "{}",
      KILO_DISABLE_DEFAULT_PLUGINS: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_VSCODE: "1",
    })
    if (mode === "v1-virtual") env.KILO_CONFIG_CONTENT = '{"model":"provider/virtual"}'
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        mode.startsWith("v1")
          ? path.resolve(import.meta.dir, "../../../opencode/test/kilocode/fixtures/config-intent.ts")
          : path.join(import.meta.dir, "fixtures", "config-intent.ts"),
        root,
        mode,
      ],
      {
        env,
        cwd: mode.startsWith("v1") ? path.resolve(import.meta.dir, "../../../opencode") : undefined,
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      child.kill("SIGKILL")
    }, 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
      await Promise.all([
        writeFile(path.join(root, "stdout.log"), stdout),
        writeFile(path.join(root, "stderr.log"), stderr),
      ])
      expect(forced, `Retained ${root}`).toBeFalse()
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      expect(stdout).toContain("CONFIG_INTENT_PASS")
      expect(stdout).not.toContain("SYNTHETIC_SECRET_SENTINEL")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await Promise.all(output)
    }
  }, 50000)

for (const mode of [
  "accepted",
  "concurrent",
  "foreign",
  "external",
  "identity",
  "io",
  "retire",
  "predecessor",
  "unsupported",
  "oversized",
  "uncertain-identity",
  "interleaved",
  "postpublication",
  "history",
])
  test(`actual Markdown own-write ${mode} retains strict physical lineage and ticket lifetime`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-markdown-lineage-"))
    const env = { ...process.env }
    for (const field of Object.keys(env))
      if (/^(?:RAYA_|KILO_|OPENCODE_|OTEL_)/i.test(field) || /API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/i.test(field))
        delete env[field]
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      KILO_TEST_HOME: root,
    })
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/config-markdown-lineage.ts"), root, mode],
      { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      child.kill("SIGKILL")
    }, 20000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, ...streams])
      await Promise.all([
        writeFile(path.join(root, "stdout.log"), stdout),
        writeFile(path.join(root, "stderr.log"), stderr),
      ])
      expect(forced, `Retained ${root}`).toBeFalse()
      expect(code, `Retained ${root}: ${stderr}`).toBe(0)
      expect(stdout).toContain("MARKDOWN_LINEAGE_PASS")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await Promise.all(streams)
    }
  }, 25000)
