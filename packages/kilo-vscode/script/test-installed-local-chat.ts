import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

// Run with Bun and pin the installed extension, CLI SHA-256, model and model digest.
// RAYA_LOCAL_SOURCE=1 exercises the current source backend instead of an installed CLI.
// RAYA_LOCAL_CONTEXT pins 8192, 16384 or 32768 and must match the actual loaded model.
// This exercises real loopback Ollama HTTP inference, not the VS Code webview.
// Profiles and receipts are retained on success and failure. Restarts are crashes,
// so a passing result does not establish graceful portable capture or migration.
type Message = {
  info: {
    id: string
    role: string
    parentID?: string
    modelID?: string
    providerID?: string
    error?: unknown
    finish?: string
    time?: { completed?: number }
  }
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string; input?: unknown } }>
}
type Host = {
  child: Bun.Subprocess
  url: string
  logs: string
  drains: Promise<void>[]
  termination?: { exit: number | null; signal: string | null; absent: boolean }
}

async function bounded<T>(work: Promise<T>, timeout: number, message: string) {
  const state: { timer?: ReturnType<typeof setTimeout> } = {}
  const expired = new Promise<never>((_, reject) => {
    state.timer = setTimeout(() => reject(new Error(message)), timeout)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(state.timer))
}

export async function installed() {
  if (process.env.RAYA_LOCAL_SOURCE === "1") {
    const root = resolve(import.meta.dir, "../../..")
    const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const revision = (await new Response(child.stdout).text()).trim()
    assert.equal(await child.exited, 0)
    return { kind: "source", exe: process.execPath, entry: join(root, "packages/opencode/src/index.ts"), revision }
  }
  const path = process.env.RAYA_INSTALLED_EXTENSION
  const version = process.env.RAYA_INSTALLED_VERSION
  const expected = process.env.RAYA_INSTALLED_CLI_SHA256
  assert.ok(path && version, "Pin RAYA_INSTALLED_EXTENSION and RAYA_INSTALLED_VERSION")
  assert.match(expected ?? "", /^[a-f0-9]{64}$/, "Pin RAYA_INSTALLED_CLI_SHA256")
  const dir = resolve(path)
  const manifest = await Bun.file(join(dir, "package.json")).json()
  assert.equal(manifest.version, version)
  const exe = join(dir, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(exe)) hash.update(chunk)
  const digest = hash.digest("hex")
  assert.equal(digest, expected, "Installed CLI does not match its acceptance pin")
  return { kind: "installed", dir, version, exe, digest, entry: undefined }
}

export async function model() {
  const url = new URL(process.env.RAYA_LOCAL_URL ?? "http://127.0.0.1:11434")
  assert.equal(url.protocol, "http:")
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), "Only literal loopback inference is allowed")
  assert.equal(url.pathname, "/")
  assert.ok(!url.username && !url.password && !url.search && !url.hash)
  const name = process.env.RAYA_LOCAL_MODEL
  const digest = process.env.RAYA_LOCAL_MODEL_SHA256
  const context = Number(process.env.RAYA_LOCAL_CONTEXT ?? "8192")
  assert.ok([8192, 16384, 32768].includes(context), "Pin a supported RAYA_LOCAL_CONTEXT")
  assert.ok(name, "Pin RAYA_LOCAL_MODEL")
  assert.match(digest ?? "", /^[a-f0-9]{64}$/, "Pin RAYA_LOCAL_MODEL_SHA256")
  const read = async (path: string) => {
    const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000), redirect: "error" })
    assert.ok(response.ok, `Ollama ${path}: ${response.status}`)
    return response.json()
  }
  const tags = (await read("/api/tags")) as { models: Array<{ name: string; digest: string }> }
  const found = tags.models.find((item) => item.name === name)
  assert.ok(found, "Pinned real model is not installed; do not substitute a synthetic fixture")
  assert.equal(found.digest, digest)
  const response = await fetch(new URL("/api/show", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  })
  assert.ok(response.ok, `Ollama model metadata: ${response.status}`)
  const metadata = (await response.json()) as { model_info: Record<string, unknown> }
  const maximum = Object.entries(metadata.model_info).find(([key]) => key.endsWith(".context_length"))?.[1]
  assert.ok(typeof maximum === "number" && context <= maximum, "Configured context exceeds the model metadata limit")
  return { name, digest, context, url: url.origin, version: await read("/api/version"), read }
}

export function environment(home: string, url: string, name: string, context: number, password: string) {
  return {
    ...process.env,
    HOME: home,
    KILO_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    RAYA_DB: join(home, "raya.db"),
    RAYA_NO_DAEMON: "1",
    KILO_NO_DAEMON: "1",
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOCOMPACT: "1",
    KILO_PURE: "1",
    KILO_AUTH_CONTENT: "{}",
    KILO_SERVER_PASSWORD: password,
    KILO_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
      permission: "deny",
      enabled_providers: ["local"],
      model: `local/${name}`,
      small_model: `local/${name}`,
      provider: {
        local: {
          name: "Pinned local acceptance",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          options: { baseURL: `${url}/v1`, localInference: true },
          models: { [name]: { name, tool_call: true, limit: { context, output: 1024 } } },
        },
      },
    }),
  }
}

export async function backend(
  app: Awaited<ReturnType<typeof installed>>,
  root: string,
  env: Record<string, string | undefined>,
  hosts: Host[],
) {
  const prefix = app.entry ? [app.exe, "run", "--conditions=browser", app.entry] : [app.exe]
  const child = Bun.spawn(
    [...prefix, "--print-logs", "--log-level", "DEBUG", "serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: app.entry ? dirname(dirname(app.entry)) : root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const host: Host = { child, url: "", logs: "", drains: [] }
  hosts.push(host)
  const ready = Promise.withResolvers<void>()
  const drain = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      host.logs = (host.logs + decoder.decode(chunk, { stream: true })).slice(-32_768)
      if (!stdout || host.url) continue
      const url = host.logs.match(/listening on (http:\/\/[^\s]+)\s/)?.[1]
      if (!url) continue
      assert.equal(new URL(url).hostname, "127.0.0.1")
      host.url = url
      ready.resolve()
    }
    if (!host.url) ready.reject(new Error("Backend exited before readiness"))
  }
  host.drains = [drain(child.stdout, true), drain(child.stderr, false)]
  // Observe rejections immediately; join still reports the original stream error.
  for (const drain of host.drains) void drain.catch((err) => ready.reject(err))
  await bounded(ready.promise, 45_000, "Installed backend readiness timed out")
  return host
}

export async function call<T>(
  host: Host,
  password: string,
  root: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
      "x-kilo-directory": root,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  })
  const text = await response.text()
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 512)}`)
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export async function stop(host: Host) {
  if (host.termination?.absent) return
  if (host.child.exitCode === null) host.child.kill("SIGKILL")
  const [exit] = await bounded(Promise.all([host.child.exited, ...host.drains]), 15_000, "Backend did not join")
  const absent = (() => {
    try {
      process.kill(host.child.pid, 0)
      return false
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
      throw err
    }
  })()
  host.termination = { exit, signal: host.child.signalCode, absent }
  assert.ok(absent, "Owned backend PID still exists")
}

function transcript(messages: Message[], prompts: string[], name: string) {
  const users = messages.filter((item) => item.info.role === "user")
  const assistants = messages.filter((item) => item.info.role === "assistant")
  const text = (item: Message) =>
    item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
  assert.deepEqual(users.map(text), prompts, "User turns must persist exactly once")
  for (const assistant of assistants) {
    assert.ok(assistant.info.time?.completed)
    assert.ok(!assistant.info.error, JSON.stringify(assistant.info.error))
    assert.equal(assistant.info.providerID, "local")
    assert.equal(assistant.info.modelID, name)
    assert.ok(users.some((user) => user.info.id === assistant.info.parentID))
    for (const part of assistant.parts.filter((part) => part.type === "tool")) {
      assert.ok(
        ["chief_route", "task", "get_goal"].includes(part.tool ?? ""),
        "Unexpected tool in bounded conversational acceptance",
      )
      assert.equal(part.state?.status, "completed", "An orchestration tool did not complete successfully")
    }
  }
  const final = assistants.filter((row) => row.info.finish !== "tool-calls" && text(row).trim())
  assert.equal(final.length, prompts.length, "Expected one final visible reply per accepted turn")
  assert.deepEqual(
    final.map((row) => row.info.parentID),
    users.map((row) => row.info.id),
  )
  return final.map(text)
}

async function main() {
  const app = await installed()
  const local = await model()
  const temp = await mkdtemp(join(tmpdir(), "raya-real-local-chat-"))
  const root = join(temp, "project")
  const home = join(temp, "home")
  await Promise.all([mkdir(root), mkdir(home)])
  await Bun.write(join(root, "README.md"), "Disposable real local-model acceptance.\n")
  const password = randomBytes(32).toString("hex")
  const env = environment(home, local.url, local.name, local.context, password)
  const hosts: Host[] = []
  const stages: unknown[] = []
  const prompts: string[] = []
  const evidence: { rows?: Message[] } = {}
  const report = resolve(
    process.env.RAYA_LOCAL_REPORT ?? join(import.meta.dir, "../../../.tmp/installed-local-chat.json"),
  )
  let error: string | undefined
  try {
    let host = await backend(app, root, env, hosts)
    const session = await call<{ id: string }>(host, password, root, "POST", "/session", {
      title: "Real local-model acceptance",
    })
    const messages = () => call<Message[]>(host, password, root, "GET", `/session/${session.id}/message`)
    const send = async (prompt: string) => {
      prompts.push(prompt)
      const start = performance.now()
      await call(host, password, root, "POST", `/session/${session.id}/prompt_async`, {
        model: { providerID: "local", modelID: local.name },
        parts: [{ type: "text", text: prompt }],
        system: "Answer briefly. /no_think",
      })
      const deadline = performance.now() + 180_000
      while (performance.now() < deadline) {
        const rows = await messages()
        evidence.rows = rows
        const assistants = rows.filter((item) => item.info.role === "assistant")
        for (const row of assistants) assert.ok(!row.info.error, JSON.stringify(row.info.error))
        const final = assistants.filter(
          (row) => row.info.finish && row.info.finish !== "tool-calls" && row.info.finish !== "unknown",
        )
        if (final.length === prompts.length && assistants.every((row) => row.info.time?.completed)) {
          const replies = transcript(rows, prompts, local.name)
          stages.push({ stage: "completed-turn", duration: performance.now() - start, rows, replies })
          console.log(
            JSON.stringify({ stage: "completed-turn", turn: prompts.length, duration: performance.now() - start }),
          )
          return rows
        }
        await Bun.sleep(250)
      }
      throw new Error("Real local-model turn did not complete within 180 seconds")
    }
    const nonce = `RAYA_${randomBytes(8).toString("hex")}`
    await send(`Remember this exact code for our conversation: ${nonce}. Reply with the code only. /no_think`)
    const first = await send("What exact code did I ask you to remember? Reply with that code only. /no_think")
    assert.ok(transcript(first, prompts, local.name).every((reply) => reply.includes(nonce)))
    const loaded = (await local.read("/api/ps")) as {
      models: Array<{ name: string; digest: string; context_length: number; size_vram: number }>
    }
    const active = loaded.models.find((item) => item.name === local.name)
    assert.ok(active, "The pinned real model is not loaded in Ollama")
    assert.equal(active.digest, local.digest)
    assert.equal(active.context_length, local.context, "Loaded model context must match the explicit acceptance pin")
    assert.equal(loaded.models.length, 1, "Acceptance requires one loaded model")
    stages.push({ stage: "real-model-loaded", loaded })
    await stop(host)
    host = await backend(app, root, env, hosts)
    assert.deepEqual(await messages(), first, "Restart changed the completed transcript")
    await Bun.sleep(2_000)
    assert.deepEqual(await messages(), first, "Completed turns replayed during restart observation")
    stages.push({ stage: "first-crash-restart", rows: first })
    const final = await send("Repeat the remembered code once more. Reply with the code only. /no_think")
    assert.ok(
      transcript(final, prompts, local.name).at(-1)?.includes(nonce),
      "Conversation context was lost after restart",
    )
    await stop(host)
    host = await backend(app, root, env, hosts)
    assert.deepEqual(await messages(), final)
    await Bun.sleep(2_000)
    assert.deepEqual(await messages(), final)
    stages.push({ stage: "second-crash-restart", rows: final })
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err)
  } finally {
    const cleanup = await Promise.allSettled(hosts.map(stop))
    const failures = cleanup.filter((item) => item.status === "rejected").map((item) => String(item.reason))
    const tools = evidence.rows?.flatMap((row) => row.parts.filter((part) => part.type === "tool")) ?? []
    await mkdir(dirname(report), { recursive: true })
    await Bun.write(
      report,
      JSON.stringify(
        {
          ok: !error && failures.length === 0,
          error,
          failures,
          app,
          model: {
            name: local.name,
            digest: local.digest,
            context: local.context,
            url: local.url,
            version: local.version,
          },
          temp,
          profileRetained: true,
          scope: `${app.kind} CLI HTTP real local-model chat and completed-turn crash recovery; excludes GUI and portable capture`,
          stages,
          evidence,
          coverage: { turns: prompts.length, toolCalls: tools.length, orchestrationExercised: tools.length > 0 },
          hosts: hosts.map((host) => ({
            pid: host.child.pid,
            url: host.url,
            termination: host.termination,
            logs: host.logs,
          })),
        },
        null,
        2,
      ),
    )
    console.log(JSON.stringify({ report, temp, ok: !error && failures.length === 0 }))
    if (error || failures.length) throw new Error(error ?? failures.join("\n"))
  }
}

if (import.meta.main) await main()
