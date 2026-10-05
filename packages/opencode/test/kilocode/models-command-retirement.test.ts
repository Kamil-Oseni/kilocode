import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../src/util/timeout"

async function command(provider: string) {
  const root = await mkdtemp(join(tmpdir(), "raya-models-retirement-"))
  const catalog = await Bun.file(join(import.meta.dir, "../tool/fixtures/models-api.json")).json()
  const model = "claude-opus-4-5"
  expect(catalog.anthropic.models[model]).toBeDefined()
  const path = join(root, "models.json")
  await Bun.write(
    path,
    JSON.stringify({ anthropic: { ...catalog.anthropic, models: { [model]: catalog.anthropic.models[model] } } }),
  )
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response("No model requests are allowed", { status: 503 })
    },
  })
  const config = JSON.stringify({
    formatter: false,
    lsp: false,
    autoupdate: false,
    permission: "deny",
    enabled_providers: ["anthropic"],
    provider: { anthropic: { options: { apiKey: "synthetic-unused-models-key", baseURL: server.url.href } } },
    experimental: { openTelemetry: false },
  })
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(RAYA|KILO)_(CONFIG|AUTH|MODELS)(_|$)|^OTEL_|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/i.test(key))
      delete env[key]
  // Match the compiled CLI smoke: the test preload must not disable actual watcher startup.
  for (const key of [
    "KILO_EXPERIMENTAL_DISABLE_FILEWATCHER",
    "RAYA_EXPERIMENTAL_DISABLE_FILEWATCHER",
    "KILO_CLIENT",
    "RAYA_CLIENT",
  ])
    delete env[key]
  const db = join(root, "raya.db")
  const proc = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "--preload",
      "./test/kilocode/fixtures/models-command-owner.ts",
      "src/index.ts",
      "models",
      provider,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...env,
        KILO_DISABLE_FFF: "1",
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        KILO_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        RAYA_DB: db,
        KILO_DB: db,
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
        RAYA_CONFIG_CONTENT: config,
        KILO_CONFIG_CONTENT: config,
        RAYA_MODELS_PATH: path,
        KILO_MODELS_PATH: path,
        RAYA_MODELS_URL: server.url.href,
        KILO_MODELS_URL: server.url.href,
        RAYA_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        RAYA_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        RAYA_DISABLE_AUTOUPDATE: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        RAYA_NO_DAEMON: "1",
        KILO_NO_DAEMON: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const streams = [new Response(proc.stdout).text(), new Response(proc.stderr).text()]
  let forced = false
  try {
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([proc.exited, ...streams]),
      45_000,
      `Actual models CLI timed out; retained profile: ${root}`,
    )
    const line = stderr.split(/\r?\n/).find((row) => row.startsWith("RAYA_MODELS_OWNER "))
    if (!line) throw new Error("Original command did not publish its writer observation")
    const owner = JSON.parse(line.slice("RAYA_MODELS_OWNER ".length))
    return { code, stdout, stderr, model, root, owner }
  } finally {
    if (proc.exitCode === null) {
      forced = true
      proc.kill("SIGKILL")
    }
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([proc.exited, ...streams]),
      10_000,
      "Models child did not join",
    )
    await server.stop(true)
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
    await Bun.write(
      join(root, "receipt.json"),
      JSON.stringify({ provider, pid: proc.pid, code, forced, absent, requests, root }),
    )
    expect(forced, `Forced child; retained profile: ${root}`).toBe(false)
    expect(absent, `Child remains; retained profile: ${root}`).toBe(true)
    expect(requests).toBe(0)
  }
}

test("actual models command lists static Anthropic models and retires naturally", async () => {
  const result = await command("anthropic")
  expect(result.code, `${result.stderr}\nProfile: ${result.root}`).toBe(0)
  expect(result.stdout.trim()).toBe(`anthropic/${result.model}`)
  expect(result.stderr).not.toContain("Raya shutdown failed")
  expect(result.stderr).not.toContain("Scheduler work could not be confirmed settled")
  expect(result.owner.installed).toBe(false)
  expect(result.owner.active).toBe(0)
  expect(result.owner.failures).toBe(0)
}, 60_000)

test("actual missing-provider models command preserves only its command failure", async () => {
  const result = await command("raya-missing-models-provider")
  expect(result.code, `${result.stderr}\nProfile: ${result.root}`).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Provider not found: raya-missing-models-provider")
  expect(result.stderr).not.toContain("Raya shutdown failed")
  expect(result.stderr).not.toContain("Scheduler work could not be confirmed settled")
  expect(result.owner.installed).toBe(false)
}, 60_000)
