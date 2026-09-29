import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { createKiloClient, type BrowserRequest, type GlobalEvent } from "@kilocode/sdk/v2/client"
import { spawn } from "../../src/util/process"
import { BrowserBridge, type BrowserConnection } from "../../src/services/browser-automation/browser-bridge"
import { BrowserOutcomeError, BrowserSession } from "../../src/services/browser-automation/browser-session"
import { DialogPendingError } from "../../src/services/browser-automation/browser-dialog"
import { normalize, type SSEEventHandler } from "../../src/services/cli-backend/sdk-sse-adapter"
import { categories, ComputerUseLeaseStore, type SensitivePolicy } from "../../src/services/computer-use/lease-store"

// Real CLI HTTP/SSE and production bridge/session, with a deterministic loopback model.
// This is transport/workflow acceptance, not real-provider quality or rendered-host acceptance.
type Payload = {
  messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}
type Mode = "happy" | "stale" | "denied" | "revoked" | "partial" | "fresh"
const modes = ["happy", "stale", "denied", "revoked", "partial"] as const
type Case = {
  turns: number
  tools: string[]
  errors: string[]
  service: number[]
  roundtrip: number[]
  issued?: number
  prompt?: number
}
const controller = new AbortController()
function empty(): Case {
  return { turns: 0, tools: [], errors: [], service: [], roundtrip: [] }
}
const cases: Record<Mode, Case> = {
  happy: empty(),
  stale: empty(),
  denied: empty(),
  revoked: empty(),
  partial: empty(),
  fresh: empty(),
}
const effects: Array<{ name: string; amount: string }> = []
const recovered = { tab: "" }
const events: Array<{ type: string; operation?: string; outcome?: string }> = []
const dispatch: Array<{ operation: string; ms: number; outcome: string }> = []
const refusals: Array<{ permission: string; sessionID: string }> = []
const failures: string[] = []
function outcomes(value: unknown) {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("failure" in item)) return []
    const failure = item.failure
    if (!failure || typeof failure !== "object" || !("receipt" in failure)) return []
    const receipt = failure.receipt
    if (!receipt || typeof receipt !== "object" || !("outcome" in receipt) || typeof receipt.outcome !== "string")
      return []
    return [receipt.outcome]
  })
}

function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return createServer((request, response) => {
    void handler(request, response).catch((err: unknown) => {
      failures.push(err instanceof Error ? err.message : "Owned HTTP fixture failed")
      controller.abort(new Error("Owned HTTP fixture failed"))
      if (!response.headersSent) response.statusCode = 500
      response.end("Owned HTTP fixture failed")
    })
  })
}

async function bounded<T>(promise: Promise<T>, ms: number, detail: string): Promise<T> {
  const state: { timer?: ReturnType<typeof setTimeout> } = {}
  const timeout = new Promise<never>((_, reject) => {
    state.timer = setTimeout(() => reject(new Error(detail)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(state.timer))
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}
function output(payload: Payload, mode: Mode, step: number) {
  const message = payload.messages?.find(
    (item) => item.role === "tool" && item.tool_call_id === `workflow_${mode}_${step}`,
  )
  assert.ok(message, `Missing actual tool output for ${mode} step ${step}`)
  return strings(message.content).join("\n")
}
function result(
  payload: Payload,
  mode: Mode,
  step: number,
): { tabID?: string; observation?: { id?: string }; snapshot?: string } {
  const text = output(payload, mode, step)
  for (const candidate of strings(
    payload.messages?.find((item) => item.tool_call_id === `workflow_${mode}_${step}`)?.content,
  )) {
    const parsed = (() => {
      try {
        return JSON.parse(candidate) as unknown
      } catch {
        return undefined
      }
    })()
    if (parsed && typeof parsed === "object" && "operation" in parsed) {
      const tabID = "tabID" in parsed && typeof parsed.tabID === "string" ? parsed.tabID : undefined
      const snapshot = "snapshot" in parsed && typeof parsed.snapshot === "string" ? parsed.snapshot : undefined
      const raw = "observation" in parsed ? parsed.observation : undefined
      const id = raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string" ? raw.id : undefined
      return { tabID, snapshot, ...(id ? { observation: { id } } : {}) }
    }
  }
  throw new Error(`Actual ${mode} tool result was not structured: ${text.slice(0, 160)}`)
}
function frame(delta: unknown, finish = "stop") {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`
}
function observation(payload: Payload, mode: Mode, step: number) {
  const id = result(payload, mode, step).observation?.id
  assert.ok(id, "Snapshot must return an actual observation identity")
  return id
}
function finish(payload: Payload, mode: Mode, step: number) {
  assert.equal(step, { happy: 8, stale: 4, denied: 3, revoked: 3, partial: 3, fresh: 1 }[mode])
  if (mode === "happy") {
    assert.match(output(payload, mode, 7), /Ada Ω/)
    assert.match(output(payload, mode, 7), /42\.75/)
  }
  if (mode === "stale")
    assert.equal(output(payload, mode, 3), "Browser observation is unknown or was already used; take a fresh snapshot")
  if (mode === "denied") assert.match(output(payload, mode, 2), /denied|reject|permission/i)
  if (mode === "revoked") assert.match(output(payload, mode, 2), /grant|revoked|authorized|stopped|denied/i)
  if (mode === "partial")
    assert.match(output(payload, mode, 2), /may already have affected the destination\. Do not automatically retry/)
  return frame({ role: "assistant", content: `WORKFLOW_${mode.toUpperCase()}_DONE` })
}
// The deterministic model intentionally enumerates independent adverse browser cases.
// eslint-disable-next-line complexity
function plan(payload: Payload, mode: Mode, origin: string) {
  const state = cases[mode]
  if (state.issued !== undefined) state.roundtrip.push(performance.now() - state.issued)
  const step = state.turns++
  assert.ok(state.turns <= 12, "Bounded loopback model exhausted")
  const tool = (name: string, args: unknown) => {
    assert.ok(
      payload.tools?.some((item) => item.function?.name === name),
      `Actual backend must advertise ${name}`,
    )
    state.tools.push(name)
    state.issued = performance.now()
    return frame(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `workflow_${mode}_${step}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      "tool_calls",
    )
  }
  if (mode === "fresh") {
    if (step === 0) {
      assert.ok(recovered.tab, "An actual browser tab must exist before restart")
      return tool("browser_snapshot", { tab_id: recovered.tab })
    }
    assert.match(output(payload, mode, 0), /Saved record|Local record/)
    return finish(payload, mode, step)
  }
  if (step === 0)
    return tool("browser_navigate", {
      url: `${origin}/form${mode === "partial" ? "?partial=1" : ""}`,
      sensitive_category: "ordinary",
    })
  const tab = result(payload, mode, 0).tabID
  assert.ok(tab, "Navigation must return an actual opaque tab identity")
  if (mode === "happy") recovered.tab = tab
  if (step === 1) return tool("browser_snapshot", { tab_id: tab })
  const observed = observation(payload, mode, 1)
  const snapshot = output(payload, mode, 1)
  for (const name of ["Name", "Amount", "Save record"])
    assert.ok(snapshot.includes(name), `Selector ${name} must come from the actual snapshot`)
  const target = (observation: string) => ({ tab_id: tab, observation_id: observation, sensitive_category: "ordinary" })
  if (mode === "happy") {
    if (step === 2)
      return tool("browser_type", { ...target(observed), selector: { kind: "label", text: "Name" }, text: "Ada Ω" })
    if ([3, 5, 7].includes(step)) return tool("browser_snapshot", { tab_id: tab })
    if (step === 4) {
      const fresh = observation(payload, mode, 3)
      assert.notEqual(fresh, observed)
      return tool("browser_type", { ...target(fresh), selector: { kind: "label", text: "Amount" }, text: "42.75" })
    }
    if (step === 6) {
      const fresh = observation(payload, mode, 5)
      return tool("browser_click", {
        ...target(fresh),
        selector: { kind: "role", role: "button", name: "Save record" },
      })
    }
  }
  if (mode === "stale") {
    if (step === 2)
      return tool("browser_navigate", { tab_id: tab, url: `${origin}/form?changed=1`, sensitive_category: "ordinary" })
    if (step === 3)
      return tool("browser_click", {
        ...target(observed),
        selector: { kind: "role", role: "button", name: "Save record" },
      })
  }
  if (mode === "denied") {
    if (step === 2)
      return tool("browser_type", {
        ...target(observed),
        selector: { kind: "label", text: "Name" },
        text: "Must not type",
      })
  }
  if (mode === "revoked") {
    if (step === 2)
      return tool("browser_click", {
        ...target(observed),
        selector: { kind: "role", role: "button", name: "Save record" },
      })
  }
  if (mode === "partial" && step === 2)
    return tool("browser_type", {
      ...target(observed),
      selector: { kind: "label", text: "Name" },
      text: "Draft Ω",
      submit: true,
    })
  return finish(payload, mode, step)
}
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) {
  server.closeAllConnections()
  await bounded(
    new Promise<void>((done, reject) => server.close((err) => (err ? reject(err) : done()))),
    5000,
    "Owned HTTP server did not close",
  )
}
// The owned process/browser lifetime and fault injection share one cleanup boundary.
// eslint-disable-next-line complexity
async function main() {
  const repo = process.env.RAYA_BROWSER_REPO
  const bun = process.env.RAYA_BROWSER_BUN
  assert.ok(repo && bun, "Use the owned Bun runner for this Node integration suite")
  const installed = process.env.RAYA_BROWSER_INSTALLED_CLI
  if (installed) {
    const receipt = process.env.RAYA_BROWSER_INSTALLED_RECEIPT
    assert.ok(receipt, "The installed gate requires an independent snapshot verification receipt")
    const verified = JSON.parse(await readFile(receipt, "utf8")) as {
      installed?: string
      cliSha256?: string
    }
    assert.equal(resolve(installed), resolve(verified.installed ?? "", "bin", "kilo.exe"))
    assert.equal(process.env.RAYA_BROWSER_INSTALLED_SHA, verified.cliSha256)
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(installed)) hash.update(chunk)
    assert.equal(hash.digest("hex"), process.env.RAYA_BROWSER_INSTALLED_SHA, "Installed CLI identity changed")
  }
  const root = await mkdtemp(join(tmpdir(), "raya-browser-workflow-"))
  const project = join(root, "project")
  const home = join(root, "home")
  await Promise.all([mkdir(project), mkdir(home)])
  await writeFile(join(project, "README.md"), "Disposable browser workflow acceptance.\n")
  const report = resolve(process.env.RAYA_BROWSER_REPORT ?? join(repo, ".tmp", "source-browser-workflow-runtime.json"))
  assert.ok(
    report.startsWith(resolve(repo, ".tmp") + sep),
    "The receipt must remain in the owned workspace report directory",
  )
  process.send?.({ version: 1, phase: "owner", pid: process.pid, root, report })
  const deadline = setTimeout(() => controller.abort(new Error("Browser workflow lifetime elapsed")), 240_000)
  const active: { mode?: Mode } = {}
  const partial = { drafts: [] as string[], stopped: false }
  const app = serve(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/form") {
      const revoke = url.searchParams.has("partial")
        ? " oninput=\"const xhr=new XMLHttpRequest();xhr.open('POST','/revoke',false);xhr.send(this.value)\""
        : ""
      response.setHeader("content-type", "text/html; charset=utf-8")
      response.end(
        `<!doctype html><html><body><h1>Local record</h1><form method="post" action="/save"><label>Name<input name="name"${revoke}></label><label>Amount<input name="amount"></label><button>Save record</button></form></body></html>`,
      )
      return
    }
    if (url.pathname === "/revoke" && request.method === "POST") {
      assert.equal(active.mode, "partial")
      assert.equal(partial.drafts.length, 0, "Unknown partial input must never be replayed")
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
        assert.ok(Buffer.concat(chunks).length <= 4096)
      }
      const draft = Buffer.concat(chunks).toString("utf8")
      assert.equal(draft, "Draft Ω")
      partial.drafts.push(draft)
      assert.equal(lease.current()?.state, "active")
      await lease.stop()
      assert.equal(lease.current(), undefined)
      partial.stopped = true
      response.end("Stopped")
      return
    }
    if (url.pathname === "/save" && request.method === "POST") {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
        assert.ok(Buffer.concat(chunks).length <= 4096)
      }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
      effects.push({ name: fields.get("name") ?? "", amount: fields.get("amount") ?? "" })
      response.setHeader("content-type", "text/html; charset=utf-8")
      response.end(
        `<html><body><h1>Saved record</h1><p>${effects.at(-1)?.name}</p><p>${effects.at(-1)?.amount}</p></body></html>`,
      )
      return
    }
    response.statusCode = 404
    response.end("Not found")
  })
  const origin = await listen(app)
  const model = serve(async (request, response) => {
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
      response.end(frame({ role: "assistant", content: "Browser workflow" }))
      return
    }
    const payload = JSON.parse(raw) as Payload
    const mode = ([...modes, "fresh"] as const).find((value) =>
      strings(payload.messages).some((text) => text.includes(`WORKFLOW_${value.toUpperCase()}`)),
    )
    assert.ok(mode, "Only explicit bounded workflow fixtures are accepted")
    const started = performance.now()
    try {
      response.end(plan(payload, mode, origin))
    } catch (err) {
      cases[mode].errors.push(err instanceof Error ? err.message : "Fixture failure")
      response.statusCode = 400
      response.end("Bounded workflow fixture failed")
    } finally {
      cases[mode].service.push(performance.now() - started)
    }
  })
  const provider = await listen(model)
  const password = randomBytes(32).toString("hex")
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
  const args = [
    "run",
    "--cwd",
    join(repo, "packages", "opencode"),
    "--conditions=browser",
    "src/index.ts",
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0",
  ]
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
  const child = spawn(installed ?? bun, installed ? ["serve", "--hostname", "127.0.0.1", "--port", "0"] : args, {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => done({ code, signal }))
  })
  const ready = Promise.withResolvers<string>()
  const observed = { backend: false, sse: false }
  const startup = { stdout: 0, stderr: 0, errors: [] as string[] }
  const drains = [child.stdout, child.stderr].map(async (stream) => {
    assert.ok(stream)
    let tail = ""
    for await (const chunk of stream) {
      if (!observed.backend) {
        startup[stream === child.stdout ? "stdout" : "stderr"] += Buffer.byteLength(chunk)
        startup.errors = [
          ...new Set([...startup.errors, ...(String(chunk).match(/\b[A-Za-z]*(?:Error|Exception)\b/g) ?? [])]),
        ]
      }
      tail = (tail + String(chunk)).slice(-16_384)
      const url = tail.match(/listening on (http:\/\/[^\s]+)/)?.[1]
      if (url) ready.resolve(url)
    }
  })
  const browser = new BrowserSession(join(root, "profile"), undefined, join(root, "artifacts"), {
    profileID: createHash("sha256").update(project).digest("hex"),
    directory: project,
  })
  // This storage port belongs solely to the disposable harness, never the user's grant settings.
  const saved: Record<string, unknown> = {}
  const receipts: string[] = []
  const loss: {
    requestID?: string
    proof?: unknown
    ack?: string
    status?: number
    dropped: boolean
    restarted: boolean
    retained: boolean
    reconciled: boolean
    hits: number
  } = { dropped: false, restarted: false, retained: false, reconciled: false, hits: 0 }
  const disk = { writes: Promise.resolve() }
  const storage = {
    get: <T>(key: string) => saved[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      saved[key] = value
      const text = JSON.stringify(saved)
      disk.writes = disk.writes.then(() => writeFile(join(root, "state.json"), text))
      await disk.writes
      if (key === "raya.computerUse.browser.failureReceipts.v1") receipts.push(...outcomes(value))
    },
  }
  const lease = new ComputerUseLeaseStore(storage)
  const authority = { armed: false, shown: 0, stopped: false, intercepted: false }
  let bridge: BrowserBridge | undefined
  let stream: Promise<void> | undefined
  let sse = new AbortController()
  let second: ReturnType<typeof spawn> | undefined
  let secondExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let secondDrains: Promise<void>[] = []
  const cleanup: {
    backend?: unknown
    browser?: boolean
    sse?: boolean
    servers?: boolean
    streams?: boolean
    absent?: boolean
    restartedBackend?: unknown
    restartedStreams?: boolean
    restartedAbsent?: boolean
    restartFallback?: boolean
  } = {}
  let error: string | undefined
  try {
    const url = await bounded(
      Promise.race([
        ready.promise,
        exited.then(() => {
          throw new Error("Backend exited before ready")
        }),
      ]),
      45_000,
      "CLI did not become ready",
    )
    observed.backend = true
    if (installed && process.env.RAYA_BROWSER_RESOURCE === "1")
      process.send?.({ version: 1, phase: "backend", pid: process.pid, backend: child.pid })
    console.log("Actual CLI ready")
    const clientFor = (url: string) =>
      createKiloClient({
        baseUrl: url,
        directory: project,
        headers: { Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}` },
        // The transport interceptor tests one exact lost acknowledgement without changing other SDK traffic.
        // eslint-disable-next-line complexity
        fetch: async (input, init) => {
          // The generated SDK passes a Request, including its SSE/caller cancellation signal.
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname
          const ack =
            installed &&
            loss.requestID &&
            path === `/kilocode/browser/${loss.requestID}/acknowledge` &&
            input instanceof Request
              ? input.clone().json()
              : undefined
          const deadlines =
            path === "/global/event" ? [] : [AbortSignal.timeout(path.endsWith("/message") ? 90_000 : 35_000)]
          if (
            installed &&
            loss.dropped &&
            !loss.restarted &&
            loss.requestID &&
            path === `/kilocode/browser/${loss.requestID}/confirmation`
          )
            throw new Error("Injected confirmation-read loss until installed backend restart")
          const response = await fetch(input, {
            ...init,
            signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...deadlines]),
          })
          if (
            installed &&
            !loss.dropped &&
            loss.requestID &&
            path === `/kilocode/browser/${loss.requestID}/acknowledge`
          ) {
            const body = await ack
            if (body && typeof body === "object" && "proof" in body && "ack" in body) {
              loss.proof = body.proof
              loss.ack = String(body.ack)
              loss.status = response.status
              loss.hits += 1
              assert.equal(response.ok, true, "Installed CLI must durably acknowledge before response loss")
              loss.dropped = true
              throw new Error("Injected loss of the first installed click acknowledgement response")
            }
          }
          if (installed && loss.requestID && path === `/kilocode/browser/${loss.requestID}/acknowledge`) loss.hits += 1
          return response
        },
      })
    let client = clientFor(url)
    const handlers = new Set<SSEEventHandler>()
    const states = new Set<(state: "connected" | "disconnected") => void>()
    const connection: BrowserConnection = {
      getClient: () => client,
      getKnownDirectories: () => [project],
      onEvent: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      onStateChange: (handler) => {
        states.add(handler)
        return () => {
          states.delete(handler)
        }
      },
    }
    bridge = new BrowserBridge(
      connection,
      {
        // The presentation port is explicitly headless; execution is the genuine production session.
        show: async (directory) => {
          assert.equal(directory, project)
          if (active.mode === "revoked" && authority.armed && ++authority.shown === 3) {
            assert.equal(lease.current()?.state, "active")
            await lease.stop()
            assert.equal(lease.current(), undefined)
            authority.stopped = true
          }
        },
        execute: async (action) => {
          if (active.mode === "revoked" && authority.stopped) authority.intercepted = true
          assert.equal(action.origin?.directory, project)
          const started = performance.now()
          try {
            const result = await browser.execute(action)
            dispatch.push({ operation: action.operation, ms: performance.now() - started, outcome: "confirmed" })
            return result
          } catch (err) {
            dispatch.push({
              operation: action.operation,
              ms: performance.now() - started,
              outcome: err instanceof BrowserOutcomeError || err instanceof DialogPendingError ? "unknown" : "refused",
            })
            throw err
          }
        },
        cancel: () => browser.takeControl("The owned browser request was cancelled."),
        uncertain: (_directory, reason) => browser.takeControl(reason),
      },
      storage,
      async (request) => lease.authorize(request),
      (request) => lease.authorize(request),
    )
    const responses: Promise<unknown>[] = []
    const connect = async () => {
      const connected = Promise.withResolvers<void>()
      stream = (async () => {
        const response = await client.global.event({
          signal: AbortSignal.any([sse.signal, controller.signal]),
          sseMaxRetryAttempts: 1,
        })
        for await (const value of response.stream as AsyncGenerator<GlobalEvent>) {
          const event = normalize(value.payload)
          if (event.type === "server.connected") {
            for (const state of states) state("connected")
            connected.resolve()
            observed.sse = true
          }
          for (const handler of handlers) handler(event, value.directory)
          if (event.type === "kilocode.browser.requested") {
            events.push({ type: event.type, operation: event.properties.operation })
            if (installed && event.properties.operation === "click") loss.requestID = event.properties.id
          }
          if (event.type === "permission.asked") {
            assert.equal(
              event.properties.permission,
              "browser_type",
              "No unrelated permission is authorized by the harness",
            )
            refusals.push({ permission: event.properties.permission, sessionID: event.properties.sessionID })
            responses.push(
              client.permission.reply(
                { directory: project, requestID: event.properties.id, reply: "reject" },
                { throwOnError: true },
              ),
            )
          }
        }
      })().catch((err) => {
        if (!sse.signal.aborted && !controller.signal.aborted) throw err
      })
      await bounded(
        Promise.race([
          connected.promise,
          stream.then(() => {
            throw new Error("SSE ended before connection")
          }),
        ]),
        15_000,
        "Actual SDK SSE did not connect",
      )
    }
    await connect()
    const verify = async (mode: Mode, id: string, before: number, parts: unknown) => {
      if (mode !== "denied")
        assert.ok(strings(parts).some((text) => text.includes(`WORKFLOW_${mode.toUpperCase()}_DONE`)))
      assert.deepEqual(cases[mode].errors, [])
      assert.equal(effects.length, mode === "happy" ? before + 1 : before)
      if (mode === "happy") assert.deepEqual(effects, [{ name: "Ada Ω", amount: "42.75" }])
      if (mode === "denied") {
        assert.ok(refusals.some((row) => row.sessionID === id))
        const messages = await client.session.messages({ directory: project, sessionID: id }, { throwOnError: true })
        assert.ok(messages.data)
        const part = messages.data
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "browser_type")
        assert.ok(
          part?.type === "tool" && part.state.status === "error",
          "Actual rejected input must persist as a failed tool result",
        )
        assert.match(part.state.error, /reject|denied|permission/i)
      }
      if (mode === "revoked") assert.deepEqual(authority, { armed: true, shown: 3, stopped: true, intercepted: false })
      if (mode === "partial") {
        assert.deepEqual(partial, { drafts: ["Draft Ω"], stopped: true })
        assert.ok(receipts.includes("unknown"), "Actual unknown receipt must be durably written before delivery")
      }
      console.log(`Actual browser case confirmed: ${mode}`)
    }
    for (const mode of installed ? (["happy"] as const) : modes) {
      active.mode = mode
      console.log(`Actual browser case started: ${mode}`)
      const before = effects.length
      const created = await client.session.create(
        {
          directory: project,
          title: `Browser ${mode}`,
          agent: "code",
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            ...["browser_navigate", "browser_snapshot", "browser_click"].map((permission) => ({
              permission,
              pattern: "*",
              action: "allow" as const,
            })),
            { permission: "browser_type", pattern: "*", action: mode === "denied" ? "ask" : "allow" },
          ],
        },
        { throwOnError: true },
      )
      assert.ok(created.data)
      if (mode === "revoked" || mode === "partial") {
        await lease.grant({
          sessionID: created.data.id,
          level: "autonomous",
          duration: "until_stopped",
          applications: "all",
          actions: ["observe", "browser"],
          sensitive: Object.fromEntries(categories.map((name) => [name, "deny"])) as SensitivePolicy,
          cooperativeInput: false,
        })
        if (mode === "revoked") authority.armed = true
      }
      const started = performance.now()
      const reply = await bounded(
        client.session.prompt(
          {
            directory: project,
            sessionID: created.data.id,
            agent: "code",
            model: { providerID: "test", modelID: "test-model" },
            parts: [
              {
                type: "text",
                text: `WORKFLOW_${mode.toUpperCase()} Use only the real browser tools for this local acceptance workflow. ${origin}/form`,
              },
            ],
          },
          { throwOnError: true, signal: controller.signal },
        ),
        90_000,
        `Actual ${mode} prompt did not finish`,
      )
      cases[mode].prompt = performance.now() - started
      assert.ok(reply.data)
      await verify(mode, created.data.id, before, reply.data.parts)
    }
    if (installed) {
      await bounded(
        (async () => {
          while (!loss.dropped) await new Promise((done) => setTimeout(done, 20))
        })(),
        10_000,
        "The installed click acknowledgement response was not lost",
      )
      assert.equal(loss.status, 200)
      assert.ok(loss.requestID && loss.proof && loss.ack)
      const journal = () =>
        saved["raya.computerUse.browser.failureReceipts.v1"] as { version?: number; items?: unknown[] } | undefined
      assert.equal(journal()?.version, 2)
      assert.equal(journal()?.items?.length, 1, "The lost ACK must retain one bridge receipt")
      loss.retained = true
      assert.deepEqual(effects, [{ name: "Ada Ω", amount: "42.75" }])
      sse.abort()
      await bounded(stream ?? Promise.resolve(), 10_000, "First installed SSE stream did not retire")
      for (const state of states) state("disconnected")
      child.kill("SIGKILL")
      await bounded(exited, 15_000, "First installed backend did not exit")
      if (process.env.RAYA_BROWSER_RESOURCE === "1")
        process.send?.({ version: 1, phase: "backend_exited", pid: process.pid, backend: child.pid })
      await bounded(Promise.all(drains), 10_000, "First installed backend streams did not join")
      second = spawn(installed, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: project,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      })
      secondExit = new Promise((done, reject) => {
        second!.once("error", reject)
        second!.once("exit", (code, signal) => done({ code, signal }))
      })
      const ready = Promise.withResolvers<string>()
      secondDrains = [second.stdout, second.stderr].map(async (pipe) => {
        assert.ok(pipe)
        let tail = ""
        for await (const chunk of pipe) {
          tail = (tail + String(chunk)).slice(-16_384)
          const url = tail.match(/listening on (http:\/\/[^\s]+)/)?.[1]
          if (url) ready.resolve(url)
        }
      })
      const url = await bounded(
        Promise.race([
          ready.promise,
          secondExit.then(() => {
            throw new Error("Restarted installed CLI exited before ready")
          }),
        ]),
        45_000,
        "Restarted installed CLI did not become ready",
      )
      client = clientFor(url)
      sse = new AbortController()
      loss.restarted = true
      if (process.env.RAYA_BROWSER_RESOURCE === "1")
        process.send?.({ version: 1, phase: "restarted_backend", pid: process.pid, backend: second.pid })
      await connect()
      await bounded(
        (async () => {
          while (journal()?.items?.length !== 0) await new Promise((done) => setTimeout(done, 20))
        })(),
        10_000,
        "The production bridge did not reconcile its retained receipt after reconnect",
      )
      loss.reconciled = true
      const proof = loss.proof as NonNullable<Extract<BrowserRequest, { operation: "click" }>["confirmation"]>
      const confirmation = await client.kilocode.browser.confirmation(
        { requestID: loss.requestID, directory: project, proof },
        { throwOnError: true },
      )
      assert.equal(confirmation.data?.completion?.outcome, "confirmed")
      assert.equal(confirmation.data?.acknowledgement?.ack, loss.ack)
      assert.equal(confirmation.data?.pending, false)
      assert.equal(confirmation.data?.dispatch?.requestID, loss.requestID)
      active.mode = "fresh"
      const fresh = await client.session.create(
        {
          directory: project,
          title: "Fresh observation after installed backend restart",
          agent: "code",
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            { permission: "browser_snapshot", pattern: "*", action: "allow" },
          ],
        },
        { throwOnError: true },
      )
      assert.ok(fresh.data)
      const reply = await bounded(
        client.session.prompt(
          {
            directory: project,
            sessionID: fresh.data.id,
            agent: "code",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "WORKFLOW_FRESH Take one authorized snapshot of the existing tab." }],
          },
          { throwOnError: true, signal: controller.signal },
        ),
        60_000,
        "Fresh installed observation did not finish",
      )
      assert.ok(reply.data)
      assert.ok(strings(reply.data.parts).some((text) => text.includes("WORKFLOW_FRESH_DONE")))
      assert.deepEqual(cases.fresh.errors, [])
      assert.deepEqual(effects, [{ name: "Ada Ω", amount: "42.75" }])
    }
    await bounded(Promise.all(responses), 5000, "Permission responses did not settle")
    assert.equal(dispatch.filter((item) => item.operation === "click" && item.outcome === "confirmed").length, 1)
    if (!installed) {
      assert.ok(dispatch.some((item) => item.operation === "click" && item.outcome === "refused"))
      assert.equal(
        dispatch.filter((item) => item.operation === "type").length,
        3,
        "Denied input must never reach the browser host",
      )
      assert.equal(dispatch.filter((item) => item.operation === "type" && item.outcome === "unknown").length, 1)
    }
    assert.deepEqual(failures, [])
  } catch (err) {
    error = err instanceof Error ? err.message : "Browser workflow failed"
    throw err
  } finally {
    clearTimeout(deadline)
    sse.abort()
    bridge?.dispose()
    const retired = await Promise.allSettled([
      bounded(browser.dispose(), 15_000, "Owned browser did not close").then(() => {
        cleanup.browser = true
      }),
      bounded(stream ?? Promise.resolve(), 10_000, "Owned SDK SSE did not retire").then(() => {
        cleanup.sse = true
      }),
      Promise.all([close(app), close(model)]).then(() => {
        cleanup.servers = true
      }),
      (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        cleanup.backend = await bounded(exited, 15_000, "Owned CLI did not exit")
        await bounded(Promise.all(drains), 10_000, "Owned CLI output did not join")
        cleanup.streams = true
        try {
          process.kill(child.pid!, 0)
          cleanup.absent = false
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") cleanup.absent = true
          else throw err
        }
      })(),
      (async () => {
        if (!second) return
        if (second.exitCode === null && second.signalCode === null) second.kill("SIGTERM")
        cleanup.restartedBackend = await bounded(secondExit!, 15_000, "Restarted installed backend did not exit").catch(
          async (err) => {
            cleanup.restartFallback = true
            second!.kill("SIGKILL")
            await bounded(secondExit!, 10_000, "Forced restarted backend did not exit")
            throw err
          },
        )
        await bounded(Promise.all(secondDrains), 10_000, "Restarted installed backend streams did not join")
        cleanup.restartedStreams = true
        try {
          process.kill(second.pid!, 0)
          cleanup.restartedAbsent = false
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") cleanup.restartedAbsent = true
          else throw err
        }
        assert.equal(cleanup.restartedAbsent, true, "Restarted installed backend remains alive")
      })(),
    ])
    await mkdir(join(report, ".."), { recursive: true })
    await writeFile(
      report,
      JSON.stringify(
        {
          version: 1,
          scope: {
            configured: {
              sourceBackend: !installed,
              installedBackend: !!installed,
              realSdkSse: true,
              productionBridge: true,
              realHeadlessChrome: true,
              loopbackModel: true,
            },
            observed: {
              ...observed,
              realHeadlessChrome: dispatch.some(
                (item) => item.operation === "navigate" && item.outcome === "confirmed",
              ),
              modelRequests: [...modes, "fresh" as const].reduce((total, mode) => total + cases[mode].turns, 0),
              bridgeActions: dispatch.length,
              partialSubmitRevocation:
                partial.stopped && dispatch.some((item) => item.operation === "type" && item.outcome === "unknown"),
            },
            renderedHost: false,
            realProvider: false,
            nativeDesktop: false,
            lostAcknowledgement: installed ? loss.dropped : "not-tested",
            backendRestart: installed ? loss.restarted : "not-tested",
            bridgeHostRestart: false,
            queuedNativeRevocation:
              "not-tested; this transport case stops the lease during host.show before host.execute",
          },
          cases,
          startup,
          timing: {
            unit: "milliseconds",
            service: "loopback fixture response preparation; no real model inference",
            roundtrip: "tool issuance to next actual provider request, including actual SDK/SSE/host/backend transport",
            prompt: "whole genuine session prompt",
            dispatch:
              "production BrowserSession host.execute including queue, grounding and native action; not isolated native dispatch",
          },
          effects,
          events,
          dispatch,
          refusals,
          failures,
          authority,
          partial,
          receipts,
          ...(installed
            ? {
                installed: { path: installed, sha256: process.env.RAYA_BROWSER_INSTALLED_SHA },
                snapshotReceipt: process.env.RAYA_BROWSER_INSTALLED_RECEIPT,
                loss: {
                  dropped: loss.dropped,
                  restarted: loss.restarted,
                  retained: loss.retained,
                  reconciled: loss.reconciled,
                  hits: loss.hits,
                  status: loss.status,
                },
                restarted: !!second,
                fresh: cases.fresh,
              }
            : {}),
          error,
          cleanup,
          retirement: retired.map((item) => item.status),
          pid: child.pid,
          ...(second ? { restartedPid: second.pid } : {}),
        },
        null,
        2,
      ),
    )
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    if (retired.every((item) => item.status === "fulfilled") && cleanup.absent)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    assert.ok(
      retired.every((item) => item.status === "fulfilled") && cleanup.absent,
      "Owned resources did not retire; isolated data retained",
    )
    process.send?.({ version: 1, phase: "retired", pid: process.pid, backend: child.pid, joined: true, report })
  }
}
process.on("message", (value: unknown) => {
  if (value && typeof value === "object" && "phase" in value && value.phase === "stop")
    controller.abort(new Error("Owned runner requested shutdown"))
})
void main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "Browser workflow failed")
    process.exitCode = 1
  })
  .finally(() => {
    if (process.connected) process.disconnect()
  })
