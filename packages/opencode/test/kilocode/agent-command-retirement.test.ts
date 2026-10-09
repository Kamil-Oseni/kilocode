import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { withTimeout } from "../../src/util/timeout"

test("cold local agent catalog in a git workspace retires without realizing a ripgrep writer", async () => {
  const root = await mkdtemp(path.resolve(import.meta.dir, "../../../../.tmp/agent-catalog-"))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  const git = Bun.spawn(["git", "init", "--quiet", workspace], {
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const init = await Promise.all([git.exited, new Response(git.stdout).text(), new Response(git.stderr).text()])
  expect(init[0], init[2]).toBe(0)
  const model = "raya-qwen35-9b-9aaf62f9b628:latest"
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response("Inference forbidden", { status: 503 })
    },
  })
  const cfg = {
    model: "qwen-local/" + model,
    small_model: "qwen-local/" + model,
    enabled_providers: ["qwen-local"],
    formatter: false,
    lsp: false,
    autoupdate: false,
    plugin: [],
    mcp: {},
    permission: { "*": "deny" },
    provider: {
      "qwen-local": {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: {
          baseURL: server.url.href,
          localInference: true,
          localInferenceAPI: "ollama",
          localInferenceToolFormat: "completion-envelope-v1",
        },
        models: {
          [model]: {
            name: model,
            tool_call: true,
            limit: { context: 32768, output: 1024 },
            options: { reasoningEffort: "none" },
          },
        },
      },
    },
    agent: {
      "local-coder": {
        mode: "primary",
        model: "qwen-local/" + model,
        steps: 4,
        prompt: "Inspect only this synthetic fixture",
        permission: {
          "*": "deny",
          read: { "*": "deny", "sum.ts": "allow", "sum.test.ts": "allow" },
          edit: { "*": "deny", "sum.ts": "allow" },
          bash: { "*": "deny", "bun test ./sum.test.ts": "allow" },
        },
      },
    },
  }
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:OTEL_|KILO_|RAYA_)|(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  const models = path.join(root, "models.json")
  await Bun.write(models, "{}")
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    KILO_TEST_HOME: root,
    KILO_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    APPDATA: path.join(root, "roaming"),
    LOCALAPPDATA: path.join(root, "local"),
    TEMP: root,
    TMP: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    RAYA_DB: path.join(root, "raya.db"),
    KILO_DB: path.join(root, "raya.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    RAYA_CONFIG_CONTENT: JSON.stringify(cfg),
    KILO_CONFIG_CONTENT: JSON.stringify(cfg),
    RAYA_MODELS_PATH: models,
    KILO_MODELS_PATH: models,
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
    KILO_DISABLE_FFF: "1",
  })
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "--preload",
      path.join(import.meta.dir, "../../node_modules/@opentui/solid/scripts/preload.js"),
      "--preload",
      path.join(import.meta.dir, "fixtures/models-command-owner.ts"),
      path.join(import.meta.dir, "../../src/index.ts"),
      "debug",
      "agent",
      "local-coder",
    ],
    { cwd: workspace, env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  let forced = false
  try {
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, ...streams]),
      45_000,
      `Agent catalog failed to retire: ${root}`,
    )
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `${stderr}\nProfile: ${root}`).toBe(0)
    const agent = JSON.parse(stdout)
    expect(agent.name).toBe("local-coder")
    expect(agent.mode).toBe("primary")
    expect(agent.model).toEqual({ providerID: "qwen-local", modelID: model })
    expect(agent.steps).toBe(4)
    expect(
      Object.keys(agent.tools)
        .filter((id) => agent.tools[id])
        .sort(),
    ).toEqual(["bash", "edit", "read", "write"])
    expect(stderr).not.toContain("Raya shutdown failed")
    expect(stderr).not.toContain("downloading ripgrep")
    const line = stderr.split(/\r?\n/).find((row) => row.startsWith("RAYA_MODELS_OWNER "))
    if (!line) throw new Error("Original command did not publish writer observation")
    expect(JSON.parse(line.slice("RAYA_MODELS_OWNER ".length))).toEqual({
      installed: false,
      closed: false,
      active: 0,
      failures: 0,
    })
    const files = await readdir(root, { recursive: true })
    expect(files.some((file) => /(?:^|[\\/])(?:rg(?:\.exe)?|\.raya-ripgrep-locks|ripgrep-[^\\/]+)$/.test(file))).toBe(
      false,
    )
    expect(requests).toBe(0)
  } finally {
    if (child.exitCode === null) {
      forced = true
      child.kill("SIGKILL")
    }
    const [code] = await withTimeout(
      Promise.all([child.exited, ...streams]),
      10_000,
      "Agent catalog child did not join",
    )
    await server.stop(true)
    await Bun.write(path.join(root, "receipt.json"), JSON.stringify({ pid: child.pid, code, forced, requests, root }))
    expect(forced).toBe(false)
    expect(() => process.kill(child.pid, 0)).toThrow()
  }
}, 60_000)
