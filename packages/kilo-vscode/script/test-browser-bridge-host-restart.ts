import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { spawn } from "../src/util/process"

type Message = {
  phase?: string
  pid?: number
  session?: string
  request?: string
  proof?: unknown
  ack?: string
  operation?: string
  journal?: unknown
}
type Payload = {
  messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}
const root = resolve(import.meta.dir, "..")
const repo = resolve(root, "../..")
const receipt = process.env.RAYA_BROWSER_INSTALLED_RECEIPT
assert.ok(receipt, "Set RAYA_BROWSER_INSTALLED_RECEIPT to an independently verified installed snapshot receipt")
const verified = JSON.parse(await readFile(receipt, "utf8")) as { installed?: string; cliSha256?: string }
assert.ok(verified.installed && verified.cliSha256)
const installed = resolve(verified.installed, "bin", "kilo.exe")
const hash = createHash("sha256")
for await (const chunk of createReadStream(installed)) hash.update(chunk)
assert.equal(hash.digest("hex"), verified.cliSha256, "Installed CLI identity changed")
const base = join(root, "tmp")
await mkdir(base, { recursive: true })
const build = await Bun.build({
  entrypoints: [join(root, "tests", "integration", "browser-bridge-host-worker.ts")],
  outdir: await mkdtemp(join(base, "bridge-host-build-")),
  target: "node",
  format: "cjs",
  external: ["playwright-core"],
})
assert.ok(build.success && build.outputs[0], build.logs.map(String).join("\n"))
const dir = await mkdtemp(join(tmpdir(), "raya-bridge-host-"))
assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
const project = join(dir, "project")
const home = join(dir, "home")
await Promise.all([mkdir(project), mkdir(home)])
await writeFile(join(project, "README.md"), "Disposable bridge host process restart acceptance.\n")
const report = resolve(repo, ".tmp", "installed-browser-bridge-host-restart.json")
const record: Record<string, unknown> = {
  version: 1,
  scope: {
    installedCli: true,
    separateBridgeHostProcesses: true,
    backendRestart: false,
    renderedHost: false,
    realProvider: false,
    nativeDesktop: false,
  },
  installed: { path: installed, sha256: verified.cliSha256, receipt },
  actions: [] as Array<{ pid: number; operation: string }>,
  effects: [] as string[],
  cleanup: {},
}
const actions = record.actions as Array<{ pid: number; operation: string }>
const effects = record.effects as string[]
const failures: string[] = []
const waits: Array<{ phase: string; match: (value: Message) => boolean; resolve: (value: Message) => void }> = []
const messages: Message[] = []
function until(phase: string, match: (value: Message) => boolean = () => true) {
  const prior = messages.find((value) => value.phase === phase && match(value))
  if (prior) return Promise.resolve(prior)
  return new Promise<Message>((resolve) => waits.push({ phase, match, resolve }))
}
function bounded<T>(promise: Promise<T>, ms: number, detail: string) {
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer.id = setTimeout(() => reject(new Error(detail)), ms)
    }),
  ]).finally(() => clearTimeout(timer.id))
}
function receive(value: unknown) {
  if (!value || typeof value !== "object" || !("phase" in value)) return
  const message = value as Message
  messages.push(message)
  if (message.phase === "action" && message.pid && message.operation)
    actions.push({ pid: message.pid, operation: message.operation })
  for (const wait of [...waits]) {
    if (wait.phase !== message.phase || !wait.match(message)) continue
    waits.splice(waits.indexOf(wait), 1)
    wait.resolve(message)
  }
}
function frame(delta: unknown, finish = "stop") {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}
function output(payload: Payload, mode: string, step: number) {
  const item = payload.messages?.find((value) => value.role === "tool" && value.tool_call_id === `host_${mode}_${step}`)
  assert.ok(item, `Missing real ${mode} browser tool output ${step}`)
  return strings(item.content).join("\n")
}
function result(payload: Payload, mode: string, step: number) {
  const item = payload.messages?.find((value) => value.role === "tool" && value.tool_call_id === `host_${mode}_${step}`)
  for (const text of strings(item?.content)) {
    const value = (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return undefined
      }
    })()
    if (value && typeof value === "object" && "operation" in value)
      return value as { tabID?: string; observation?: { id?: string } }
  }
  throw new Error(`Unstructured ${mode} tool result: ${output(payload, mode, step).slice(0, 160)}`)
}
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) {
  if (!server.listening) return
  server.closeAllConnections()
  await bounded(
    new Promise<void>((done, reject) =>
      server.close((err) => {
        if (err && (!("code" in err) || err.code !== "ERR_SERVER_NOT_RUNNING")) reject(err)
        else done()
      }),
    ),
    5000,
    "Owned loopback server did not close",
  )
}
const app = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (path === "/form") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(
      '<!doctype html><html><body><h1>Local record</h1><form method="post" action="/save"><label>Name<input name="name"></label><button>Save record</button></form></body></html>',
    )
    return
  }
  if (path === "/save" && request.method === "POST") {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
      assert.ok(Buffer.concat(chunks).length <= 4096)
    }
    effects.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("name") ?? "")
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<html><body><h1>Saved record</h1><p>${effects.at(-1)}</p></body></html>`)
    return
  }
  if (path === "/result") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(
      `<html><body><h1>Saved record</h1><p>Count ${effects.length}</p><p>${effects.at(-1) ?? ""}</p></body></html>`,
    )
    return
  }
  response.writeHead(404).end()
})
const origin = await listen(app)
const turns = { first: 0, fresh: 0 }
const model = createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
    assert.ok(Buffer.concat(chunks).length <= 2_000_000)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  response.setHeader("content-type", "text/event-stream")
  if (raw.includes("Generate a title for this conversation")) {
    response.end(frame({ role: "assistant", content: "Bridge host restart" }))
    return
  }
  const payload = JSON.parse(raw) as Payload
  const mode = strings(payload.messages).some((text) => text.includes("HOST_FIRST")) ? "first" : "fresh"
  try {
    const step = turns[mode]++
    assert.ok(step < 8)
    const tool = (name: string, args: unknown) => {
      assert.ok(payload.tools?.some((item) => item.function?.name === name))
      return frame(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `host_${mode}_${step}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      )
    }
    const tab = step > 0 ? result(payload, mode, 0).tabID : undefined
    if (mode === "first") {
      if (step === 0) {
        response.end(tool("browser_navigate", { url: `${origin}/form`, sensitive_category: "ordinary" }))
        return
      }
      assert.ok(tab)
      if (step === 1) {
        response.end(tool("browser_snapshot", { tab_id: tab }))
        return
      }
      if (step === 2) {
        const observed = result(payload, mode, 1).observation?.id
        assert.ok(observed)
        response.end(
          tool("browser_type", {
            tab_id: tab,
            observation_id: observed,
            sensitive_category: "ordinary",
            selector: { kind: "label", text: "Name" },
            text: "Host restart Ω",
          }),
        )
        return
      }
      if (step === 3) {
        response.end(tool("browser_snapshot", { tab_id: tab }))
        return
      }
      if (step === 4) {
        const observed = result(payload, mode, 3).observation?.id
        assert.ok(observed)
        response.end(
          tool("browser_click", {
            tab_id: tab,
            observation_id: observed,
            sensitive_category: "ordinary",
            selector: { kind: "role", role: "button", name: "Save record" },
          }),
        )
        return
      }
      response.end(frame({ role: "assistant", content: "HOST_FIRST_DONE" }))
      return
    }
    if (step === 0) {
      response.end(tool("browser_navigate", { url: `${origin}/result`, sensitive_category: "ordinary" }))
      return
    }
    assert.ok(tab)
    if (step === 1) {
      response.end(tool("browser_snapshot", { tab_id: tab }))
      return
    }
    assert.match(output(payload, mode, 1), /Count 1/)
    assert.match(output(payload, mode, 1), /Host restart Ω/)
    response.end(frame({ role: "assistant", content: "HOST_FRESH_DONE" }))
  } catch (err) {
    failures.push(err instanceof Error ? err.message : "Model fixture error")
    response.writeHead(400).end("Bounded model fixture failed")
  }
})
const provider = await listen(model)
const password = crypto.randomUUID().replaceAll("-", "")
const cfg = {
  formatter: false,
  lsp: false,
  experimental: { openTelemetry: false },
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "loopback", baseURL: provider },
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          tool_call: true,
          reasoning: false,
          attachment: false,
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
        },
      },
    },
  },
}
const env = {
  ...process.env,
  HOME: home,
  KILO_TEST_HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  KILO_SERVER_PASSWORD: password,
  KILO_CLIENT: "vscode",
  KILO_TELEMETRY_LEVEL: "off",
  KILO_CONFIG_CONTENT: JSON.stringify(cfg),
  KILO_DISABLE_PROJECT_CONFIG: "1",
  KILO_PURE: "1",
  KILO_DISABLE_AUTOUPDATE: "1",
  KILO_DISABLE_AUTOCOMPACT: "1",
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_AUTH_CONTENT: "{}",
  RAYA_DB: join(home, "workflow.db"),
  RAYA_NO_DAEMON: "1",
  KILO_NO_DAEMON: "1",
}
const backend = Bun.spawn([installed, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project,
  env,
  stdout: "pipe",
  stderr: "pipe",
  windowsHide: true,
})
const ready = Promise.withResolvers<string>()
const drains = [backend.stdout, backend.stderr].map(async (stream) => {
  let tail = ""
  for await (const chunk of stream) {
    tail = (tail + Buffer.from(chunk).toString()).slice(-16_384)
    const url = tail.match(/listening on (http:\/\/[^\s]+)/)?.[1]
    if (url) ready.resolve(url)
  }
})
const hosts: Array<{
  phase: number
  child: ReturnType<typeof spawn>
  exited: Promise<unknown>
  drains: Promise<void>[]
}> = []
const cleanup = record.cleanup as Record<string, unknown>
let error: string | undefined
try {
  const url = await bounded(
    Promise.race([
      ready.promise,
      backend.exited.then(() => {
        throw new Error("Installed backend exited before ready")
      }),
    ]),
    45_000,
    "Installed backend did not become ready",
  )
  record.backend = { pid: backend.pid, url }
  const client = createKiloClient({
    baseUrl: url,
    directory: project,
    headers: { Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}` },
  })
  const start = async (phase: number) => {
    const child = spawn("node", [build.outputs[0].path], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, RAYA_HOST_CONFIG: JSON.stringify({ phase, url, project, root: dir, password }) },
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => done({ code, signal }))
    })
    child.on("message", receive)
    const pipes = [child.stdout, child.stderr].map(async (stream) => {
      assert.ok(stream)
      for await (const chunk of stream) process.stdout.write(Buffer.from(chunk))
    })
    assert.ok(child.pid)
    hosts.push({ phase, child, exited, drains: pipes })
    const ready = await bounded(
      until("ready", (value) => value.pid === child.pid),
      25_000,
      `Bridge host ${phase} did not connect`,
    )
    return { child, ready }
  }
  const first = await start(1)
  assert.ok(first.child.pid !== backend.pid)
  const session = await client.session.create(
    {
      directory: project,
      title: "Host death action",
      agent: "code",
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        ...["browser_navigate", "browser_snapshot", "browser_type", "browser_click"].map((permission) => ({
          permission,
          pattern: "*",
          action: "allow" as const,
        })),
      ],
    },
    { throwOnError: true },
  )
  assert.ok(session.data)
  first.child.send({ phase: "grant", session: session.data.id })
  await bounded(
    until("granted", (value) => value.pid === first.child.pid && value.session === session.data?.id),
    10_000,
    "First host lease was not granted",
  )
  const prompt = client.session.prompt({
    directory: project,
    sessionID: session.data.id,
    agent: "code",
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: "HOST_FIRST Execute one authorized local browser save." }],
  })
  void prompt.catch(() => undefined)
  const dropped = await bounded(
    until("dropped", (value) => value.pid === first.child.pid),
    90_000,
    "First host did not lose the native click ACK response",
  )
  assert.ok(dropped.request && dropped.proof && dropped.ack)
  assert.deepEqual(effects, ["Host restart Ω"])
  const journal = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Record<string, unknown>
  const saved = journal["raya.computerUse.browser.failureReceipts.v1"] as
    | { version?: number; items?: Array<{ id?: string; completion?: { ack?: string; outcome?: string } }> }
    | undefined
  assert.equal(saved?.version, 2)
  assert.equal(saved.items?.length, 1)
  assert.equal(saved.items[0]?.id, dropped.request)
  assert.equal(saved.items[0]?.completion?.ack, dropped.ack)
  record.loss = {
    dropped: true,
    request: dropped.request,
    ack: dropped.ack,
    durableV2: true,
    firstPid: first.child.pid,
  }
  first.child.send({ phase: "retire-browser" })
  await bounded(
    until("browser-retired", (value) => value.pid === first.child.pid),
    15_000,
    "Owned first Chromium did not retire",
  )
  cleanup.firstBrowserRetired = true
  assert.equal(first.child.exitCode, null, "The first bridge host exited before the injected host-death boundary")
  assert.equal(first.child.kill("SIGKILL"), true, "Owned first bridge host could not be terminated")
  await bounded(hosts[0].exited, 15_000, "First bridge host process did not exit")
  await bounded(Promise.all(hosts[0].drains), 10_000, "First host streams did not join")
  assert.throws(() => process.kill(first.child.pid!, 0), { code: "ESRCH" })
  cleanup.firstHostAbsent = true
  const second = await start(2)
  assert.ok(second.child.pid !== first.child.pid && second.child.pid !== backend.pid)
  const restored = second.ready.journal as
    | { version?: number; items?: Array<{ id?: string; completion?: { ack?: string } }> }
    | undefined
  assert.equal(restored?.version, 2)
  assert.equal(restored.items?.[0]?.id, dropped.request)
  assert.equal(restored.items?.[0]?.completion?.ack, dropped.ack)
  record.restored = { pid: second.child.pid, version: 2, request: restored.items[0].id, fromDisk: true }
  await bounded(
    (async () => {
      while (true) {
        const data = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Record<string, unknown>
        const current = data["raya.computerUse.browser.failureReceipts.v1"] as { items?: unknown[] } | undefined
        if (current?.items?.length === 0) return
        await Bun.sleep(50)
      }
    })(),
    12_000,
    "Second host did not reconcile its disk-restored receipt",
  )
  const confirmation = await client.kilocode.browser.confirmation(
    {
      requestID: dropped.request,
      directory: project,
      proof: dropped.proof as NonNullable<Parameters<typeof client.kilocode.browser.confirmation>[0]["proof"]>,
    },
    { throwOnError: true },
  )
  assert.equal(confirmation.data?.completion?.outcome, "confirmed")
  assert.equal(confirmation.data?.acknowledgement?.ack, dropped.ack)
  assert.equal(confirmation.data?.pending, false)
  assert.equal(backend.exitCode, null, "The installed backend must stay alive during host restart")
  record.confirmation = {
    outcome: confirmation.data.completion.outcome,
    ack: confirmation.data.acknowledgement.ack,
    pending: confirmation.data.pending,
  }
  second.child.send({ phase: "resume" })
  await bounded(
    until("resumed", (value) => value.pid === second.child.pid),
    5000,
    "Reconciled bridge did not resume its exact scope",
  )
  const fresh = await client.session.create(
    {
      directory: project,
      title: "Fresh observation after bridge host death",
      agent: "code",
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "browser_navigate", pattern: "*", action: "allow" },
        { permission: "browser_snapshot", pattern: "*", action: "allow" },
      ],
    },
    { throwOnError: true },
  )
  assert.ok(fresh.data)
  second.child.send({ phase: "grant", session: fresh.data.id })
  await bounded(
    until("granted", (value) => value.pid === second.child.pid && value.session === fresh.data?.id),
    10_000,
    "Second host lease was not granted",
  )
  const observed = await bounded(
    client.session.prompt(
      {
        directory: project,
        sessionID: fresh.data.id,
        agent: "code",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "HOST_FRESH Take a fresh authorized observation of the saved destination." }],
      },
      { throwOnError: true },
    ),
    60_000,
    "Fresh observation did not complete",
  )
  assert.ok(observed.data && strings(observed.data.parts).some((text) => text.includes("HOST_FRESH_DONE")))
  assert.deepEqual(effects, ["Host restart Ω"])
  assert.equal(actions.filter((value) => value.operation === "click").length, 1)
  assert.equal(actions.filter((value) => value.pid === second.child.pid && value.operation === "click").length, 0)
  assert.deepEqual(failures, [])
  record.fresh = {
    session: fresh.data.id,
    turns: turns.fresh,
    destinationCount: effects.length,
    postResume: true,
    authorizedDisposableLease: true,
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err)
  record.result = "fail"
  record.error = error
  record.primaryFailure = error
} finally {
  const retired = await Promise.allSettled(
    hosts.map(async (host) => {
      assert.ok(host.child.pid)
      if (host.child.exitCode === null && host.child.signalCode === null && host.phase === 2)
        host.child.send({ phase: "stop" })
      if (host.child.exitCode === null && host.child.signalCode === null) {
        const graceful = await bounded(host.exited, 20_000, `Host ${host.phase} graceful retirement expired`).then(
          () => true,
          () => false,
        )
        if (!graceful && host.child.exitCode === null && host.child.signalCode === null) {
          const kill = Bun.spawn(["taskkill", "/PID", String(host.child.pid), "/T", "/F"], {
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          })
          const code = await bounded(kill.exited, 10_000, `Owned host ${host.phase} tree fallback failed`)
          cleanup.hostFallback = { phase: host.phase, code }
          if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL")
        }
      }
      await bounded(host.exited, 10_000, `Owned host ${host.phase} exit did not join`)
      await bounded(Promise.all(host.drains), 10_000, `Owned host ${host.phase} output did not join`)
      assert.throws(() => process.kill(host.child.pid!, 0), { code: "ESRCH" })
      return { phase: host.phase, pid: host.child.pid, absent: true }
    }),
  )
  cleanup.hosts = retired.map((item, index) =>
    item.status === "fulfilled"
      ? item.value
      : { phase: hosts[index].phase, pid: hosts[index].child.pid, error: String(item.reason) },
  )
  cleanup.hostsAbsent = retired.every((item) => item.status === "fulfilled")
  const backendRetired = await Promise.allSettled([
    (async () => {
      if (backend.exitCode === null) backend.kill()
      await bounded(backend.exited, 15_000, "Owned installed backend did not exit")
      await bounded(Promise.all(drains), 10_000, "Owned backend streams did not join")
      assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" })
      cleanup.backendAbsent = true
    })(),
    Promise.all([close(app), close(model)]).then(() => {
      cleanup.servers = true
    }),
  ])
  cleanup.backendRetirement = backendRetired.map((item) =>
    item.status === "fulfilled" ? "fulfilled" : String(item.reason),
  )
  record.turns = turns
  record.ipc = messages
    .filter((value) =>
      ["click-request", "ack-seen", "dropped", "browser-retired", "ready", "fetch-fault"].includes(value.phase ?? ""),
    )
    .map((value) => ({
      phase: value.phase,
      pid: value.pid,
      request: value.request,
      ...("path" in value ? { path: value.path } : {}),
      ...("error" in value ? { error: value.error } : {}),
    }))
  record.failures = failures
  record.backendRestart = false
  record.bridgeHostRestart = hosts.length === 2 && cleanup.firstHostAbsent === true
  if (cleanup.hostFallback || !cleanup.hostsAbsent || !cleanup.backendAbsent || !cleanup.servers) {
    record.result = "fail"
    record.cleanupFailure = "Owned resource cleanup was not fully confirmed"
  }
  if (!record.result) record.result = "pass"
  await mkdir(join(repo, ".tmp"), { recursive: true })
  await writeFile(report, JSON.stringify(record, null, 2))
  if (cleanup.backendAbsent && cleanup.hostsAbsent && cleanup.servers) {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    assert.ok(resolve(build.outputs[0].path, "..").startsWith(resolve(base) + sep))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(resolve(build.outputs[0].path, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
if (record.result !== "pass") throw new Error(`${record.error ?? error}; receipt: ${report}`)
console.log(`Bridge host restart accepted: ${report}`)
