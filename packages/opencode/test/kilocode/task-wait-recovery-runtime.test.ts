import { test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream, watch } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Database as Sqlite } from "bun:sqlite"

type Diagnostic = { text: string; bytes: number; failed: boolean }
const lifetime = new AbortController()
type Host = {
  url: string
  child: Bun.Subprocess
  stderr: Promise<void>
  stdout: Promise<void>
  diagnostic: Diagnostic
  failed: boolean
  markers: { revival: boolean; failed: boolean; refused: boolean }
  termination?: { exit: number | null; signal: string | null; absent: boolean }
}
type Run = { id: string; agentID: string; status: string; sessionID: string; blockedReason?: string }
type Dispatch = { id: string; messageID: string; phase: string; intent: string; finishedAt?: number }
type Receipt = { source: string; session_id: string | null; delivery_id: string | null; delivered_at: number | null }
type Message = {
  info: {
    id: string
    role: string
    parentID?: string
    finish?: string
    error?: { name?: string }
    time?: { completed?: number }
  }
}
type Recovery = {
  version: number
  dispatchID: string
  messageID: string
  oldIntent: string
  intent: string
  source: string
  outcome: string
  execution: string
  at: number
  reviewedAt?: number
  reviewIntent?: string
}
type Goal = {
  status: string
  intent?: string
  blockedReason?: string
  dispatch?: Dispatch & { outcome?: string; assistantID?: string }
  reply?: { messageID: string; body: string }
  replyRecovery?: Recovery
  accounted?: { userID: string; messages: string[] }
  completion?: string
  audit?: { verifiedAt?: number; requirements?: Array<{ passed: boolean; evidence: Array<{ callID: string }> }> }
}
async function installed() {
  const value = process.env.RAYA_INSTALLED_EXTENSION
  const expected = process.env.RAYA_INSTALLED_VERSION
  if (!value && !expected)
    return { exe: process.execPath, dir: resolve(import.meta.dir, "../.."), version: "source-runtime", source: true }
  assert.ok(value && expected, "Set both RAYA_INSTALLED_EXTENSION and RAYA_INSTALLED_VERSION")
  const dir = resolve(value)
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: string }
  assert.equal(manifest.version, expected)
  assert.match(expected, /^\d+\.\d+\.\d+-snapshot\+[a-f0-9]+\./)
  const exe = join(dir, "bin", "kilo.exe")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(exe, { highWaterMark: 65_536 })) hash.update(chunk)
  return { exe, dir, version: expected, digest: hash.digest("hex"), source: false }
}
function fixture(mode: "error" | "interrupted", scheduled = false, root?: string) {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const state = { requests: 0, questions: 0, failures: 0, followups: 0, reads: 0, audits: 0, proof: false }
  const response = (delta: unknown, finish = "stop") =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("Not found", { status: 404 })
      const body = await req.text()
      if (body.includes("Generate a title for this conversation")) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"Archive test"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      state.requests++
      if (state.requests > 8) return new Response("Bounded model fixture exhausted", { status: 503 })
      const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
      const followup = payload.messages?.some(
        (message) => message.role === "user" && JSON.stringify(message.content)?.includes("RECOVERY_FOLLOWUP"),
      )
      if (followup && scheduled) {
        assert.ok(root)
        if (!state.followups) state.followups++
        const tool = (name: string, id: string, args: unknown) =>
          response(
            {
              role: "assistant",
              tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
            },
            "tool_calls",
          )
        if (!state.reads) {
          state.reads++
          return tool("read", "call_scheduled_read", { filePath: join(root, "README.md") })
        }
        if (!state.audits) {
          state.proof =
            payload.messages?.some(
              (message) =>
                message.role === "tool" &&
                JSON.stringify(message.content)?.includes("Disposable error WAIT recovery acceptance."),
            ) === true
          assert.ok(state.proof, "The real read tool result was not present before completion")
          state.audits++
          return tool("update_goal", "call_scheduled_audit", {
            status: "complete",
            audit: {
              summary: "Verified the disposable README after clarification.",
              requirements: [
                {
                  requirement: "Read and verify the disposable README after clarification.",
                  passed: true,
                  evidence: [
                    {
                      callID: "call_scheduled_read",
                      summary: "The actual read returned the disposable README contents.",
                    },
                  ],
                },
              ],
            },
          })
        }
        return response({ role: "assistant", content: "SCHEDULED_FOLLOWUP_VERIFIED" })
      }
      if (followup) {
        state.followups++
        return response({ role: "assistant", content: "RECOVERY_FOLLOWUP_ACK" })
      }
      if (body.includes("RECOVERY_ORIGINAL") && state.questions === 0) {
        state.questions++
        return response(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_installed_question",
                type: "function",
                function: {
                  name: "question",
                  arguments: JSON.stringify({
                    questions: [
                      {
                        header: "Choice",
                        question: "Which follow-up should I use?",
                        options: [{ label: "Proceed", description: "Continue this same worker conversation." }],
                      },
                    ],
                  }),
                },
              },
            ],
          },
          "tool_calls",
        )
      }
      if (body.includes("RECOVERY_ORIGINAL")) {
        state.failures++
        started.resolve()
        if (mode === "error") return new Response("Injected nonretryable old-intent provider failure", { status: 400 })
        await release.promise
        return response({ role: "assistant", content: "LATE_OLD_REPLY" })
      }
      return response({ role: "assistant", content: "UNEXPECTED_REPLY" })
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/v1`,
    count: () => state.requests,
    receipt: () => ({ ...state }),
    started: started.promise,
    release: () => release.resolve(),
  }
}

function environment(home: string, url: string, password: string) {
  return {
    ...process.env,
    HOME: home,
    KILO_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    KILO_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: url },
        },
      },
    }),
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_PURE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_AUTOCOMPACT: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_AUTH_CONTENT: "{}",
    RAYA_DB: join(home, "archive-acceptance.db"),
    KILO_SERVER_PASSWORD: password,
    RAYA_NO_DAEMON: "1",
    KILO_NO_DAEMON: "1",
  }
}

async function bounded<T>(work: Promise<T>, ms: number, message: string) {
  const state: { timer?: ReturnType<typeof setTimeout> } = {}
  const timeout = new Promise<never>((_, reject) => {
    state.timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(state.timer))
}

async function drain(stream: ReadableStream<Uint8Array>, receive: (value: Uint8Array) => void) {
  const reader = stream.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      receive(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function backend(
  app: Awaited<ReturnType<typeof installed>>,
  root: string,
  env: Record<string, string | undefined>,
  hosts: Host[],
) {
  const args = app.source
    ? [
        app.exe,
        "run",
        "--cwd",
        app.dir,
        "--conditions=browser",
        "src/index.ts",
        "--print-logs",
        "--log-level",
        "INFO",
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ]
    : [app.exe, "--print-logs", "--log-level", "INFO", "serve", "--hostname", "127.0.0.1", "--port", "0"]
  const child = Bun.spawn(args, {
    cwd: app.source ? app.dir : root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const diagnostic: Diagnostic = { text: "", bytes: 0, failed: false }
  const markers = { revival: false, failed: false, refused: false }
  const observe = (value: string) => {
    if (value.includes("Raya routine revival complete")) markers.revival = true
    if (value.includes("task revive failed")) markers.failed = true
    if (value.includes("This routine is still owned by another backend or needs recovery review."))
      markers.refused = true
  }
  const decoder = new TextDecoder()
  const stderr = drain(child.stderr, (chunk) => {
    diagnostic.bytes += chunk.length
    diagnostic.text = (diagnostic.text + decoder.decode(chunk, { stream: true })).slice(-16_384)
    observe(diagnostic.text)
  }).catch(() => {
    diagnostic.failed = true
  })
  const host: Host = { url: "", child, stderr, stdout: Promise.resolve(), diagnostic, failed: false, markers }
  hosts.push(host)
  const ready = Promise.withResolvers<string>()
  const text = new TextDecoder()
  let output = ""
  host.stdout = drain(child.stdout, (chunk) => {
    output = (output + text.decode(chunk, { stream: true })).slice(-16_384)
    observe(output)
    if (host.url) return
    const url = output.match(/listening on (http:\/\/[^\s]+)\s/)?.[1]
    if (!url) return
    host.url = url
    ready.resolve(url)
    output = ""
  }).then(
    () => ready.reject(new Error("Installed backend exited before ready")),
    () => {
      host.failed = true
      ready.reject(new Error("Installed backend output failed"))
    },
  )
  await bounded(ready.promise, 45_000, "Installed backend did not become ready")
  return host
}

function request(host: Host, password: string, root: string, method: string, path: string, body?: unknown) {
  return fetch(`${host.url}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
      "x-kilo-directory": root,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([AbortSignal.timeout(35_000), lifetime.signal]),
  })
}

async function call(host: Host, password: string, root: string, method: string, path: string, body?: unknown) {
  const response = await request(host, password, root, method, path, body)
  const value = await response.json()
  if (response.status !== 200)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value).slice(0, 512)}`)
  return value
}

async function events(host: Host, password: string, root: string) {
  const ctl = new AbortController()
  const response = await fetch(`${host.url}/event`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
      "x-kilo-directory": root,
    },
    signal: ctl.signal,
  })
  assert.equal(response.status, 200)
  const body = response.body
  assert.ok(body)
  const closes: Array<{ sessionID?: string; reason?: string; messageID?: string; goalIntent?: string }> = []
  const ready = Promise.withResolvers<void>()
  const state: { connected: boolean; error?: unknown } = { connected: false }
  const task = (async () => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        pending += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
        while (pending.includes("\n\n")) {
          const index = pending.indexOf("\n\n")
          const frame = pending.slice(0, index)
          pending = pending.slice(index + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) continue
          const value = JSON.parse(data) as { type?: string; properties?: Record<string, unknown> }
          if (value.type === "server.connected") {
            state.connected = true
            ready.resolve()
          }
          if (value.type !== "session.turn.close") continue
          closes.push({
            sessionID: typeof value.properties?.sessionID === "string" ? value.properties.sessionID : undefined,
            reason: typeof value.properties?.reason === "string" ? value.properties.reason : undefined,
            messageID: typeof value.properties?.messageID === "string" ? value.properties.messageID : undefined,
            goalIntent: typeof value.properties?.goalIntent === "string" ? value.properties.goalIntent : undefined,
          })
        }
      }
    } finally {
      reader.releaseLock()
      if (!state.connected && !ctl.signal.aborted) ready.reject(new Error("Event stream closed before ready"))
    }
  })().catch((err) => {
    if (ctl.signal.aborted) return
    state.error = err
    ready.reject(err)
  })
  await bounded(ready.promise, 10_000, "Event stream did not become ready")
  return {
    closes,
    stop: async () => {
      ctl.abort()
      const joined = await bounded(task, 5_000, "Event stream did not close").then(
        () => true,
        () => false,
      )
      return { joined, failed: state.error !== undefined }
    },
  }
}

async function wait(check: () => Promise<boolean> | boolean, message: string, timeout = 20_000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    lifetime.signal.throwIfAborted()
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function stop(host: Host) {
  if (host.termination?.absent) return
  if (host.child.exitCode === null) host.child.kill("SIGKILL")
  const [exit] = await bounded(
    Promise.all([host.child.exited, host.stderr, host.stdout]),
    15_000,
    "An owned backend did not join",
  )
  const absent = (() => {
    try {
      process.kill(host.child.pid, 0)
      return false
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ESRCH") return true
      throw new Error("An owned backend process absence could not be confirmed", { cause: err })
    }
  })()
  host.termination = {
    exit: typeof exit === "number" && Number.isFinite(exit) ? exit : null,
    signal: host.child.signalCode,
    absent,
  }
  assert.ok(absent, "An exited owned backend PID remains present; isolated data retained")
  assert.ok(!host.failed && !host.diagnostic.failed, "An owned backend output stream failed")
}

async function scenario(mode: "error" | "interrupted", lost = false, scheduled = false) {
  const timer = setTimeout(
    () => lifetime.abort(new Error("Actual runtime acceptance deadline elapsed")),
    scheduled ? 230_000 : 150_000,
  )
  const app = await installed()
  const temp = await mkdtemp(join(tmpdir(), `raya-wait-${mode}-`))
  const root = join(temp, "project")
  const home = join(temp, "home")
  await Promise.all([mkdir(root), mkdir(home)])
  await writeFile(join(root, "README.md"), `Disposable ${mode} WAIT recovery acceptance.\n`)
  const fake = fixture(mode, scheduled, root)
  const env = environment(home, fake.url, randomBytes(32).toString("hex"))
  const password = env.KILO_SERVER_PASSWORD
  const hosts: Host[] = []
  const stages: unknown[] = []
  const report = resolve(
    process.env.RAYA_WAIT_RECOVERY_REPORT ??
      join(
        import.meta.dir,
        `../../../../.tmp/source-routine-wait-${scheduled ? "scheduled-once" : lost ? "lost-review" : mode === "error" ? "error400" : mode}-recovery.json`,
      ),
  )
  const storage = join(home, ".local", "share", "kilo", "storage")
  const saved = async (sid: string) => {
    const value = JSON.parse(await readFile(join(storage, "raya", "goal", sid) + ".json", "utf8")) as Goal
    return {
      status: value.status,
      intent: value.intent,
      blockedReason: value.blockedReason,
      dispatch: value.dispatch,
      reply: value.reply,
      replyRecovery: value.replyRecovery,
      accounted: value.accounted,
      completion: value.completion,
      audit: value.audit,
    }
  }
  let host: Host | undefined
  let trace: Awaited<ReturnType<typeof events>> | undefined
  let error: string | undefined
  const create = async (name: string, tools: string[]) => {
    assert.ok(host)
    return (await call(host, password, root, "POST", "/kilocode/agent", {
      name,
      objective: scheduled
        ? "RECOVERY_ORIGINAL Read and verify the disposable README after clarification."
        : "Answer this synthetic worker conversation.",
      access: "brief",
      tools,
      model: { providerID: "test", id: "test-model" },
      schedule: scheduled ? { kind: "once", at: Date.now() - 1_000 } : { kind: "manual" },
      ...(scheduled ? { enabled: true } : {}),
    })) as { id: string }
  }
  const runs = async (id: string) => {
    assert.ok(host)
    return (await call(host, password, root, "GET", `/kilocode/agent/${id}/runs`)) as Run[]
  }
  const send = async (id: string, source: string, body: string) => {
    assert.ok(host)
    return await call(host, password, root, "POST", `/kilocode/agent/${id}/inbox`, { source, body })
  }
  const receipts = (id: string) => {
    const ledger = new Sqlite(join(home, "archive-acceptance.db"), { readonly: true })
    try {
      return ledger
        .query<
          Receipt,
          [string]
        >("SELECT source, session_id, delivery_id, delivered_at FROM raya_routine_message WHERE agent_id = ? AND kind = 'user' ORDER BY time_created, id")
        .all(id)
    } finally {
      ledger.close()
    }
  }
  const occurrence = (id: string) => {
    const ledger = new Sqlite(join(home, "archive-acceptance.db"), { readonly: true })
    try {
      return {
        rows: ledger
          .query<
            {
              id: string
              claim_id: string
              session_id: string
              state: string
              schedule_version: number
              scheduled_at: number
              observed_at: number
              timezone: string | null
            },
            [string]
          >(
            "SELECT id, claim_id, session_id, state, schedule_version, scheduled_at, observed_at, timezone FROM raya_routine_occurrence WHERE agent_id = ? ORDER BY scheduled_at",
          )
          .all(id),
        cursor: ledger
          .query<
            { schedule_version: number; through: number; time_updated: number },
            [string]
          >("SELECT schedule_version, through, time_updated FROM raya_routine_cursor WHERE agent_id = ?")
          .all(id),
      }
    } finally {
      ledger.close()
    }
  }
  try {
    host = await backend(app, root, env, hosts)
    trace = await events(host, password, root)
    const worker = await create(`Waiting ${mode} recovery`, scheduled ? ["question", "read"] : ["question"])
    if (!scheduled) await send(worker.id, `${mode}_original`, "RECOVERY_ORIGINAL")
    type Question = { id: string; sessionID: string; tool?: { callID: string } }
    let pending: Question | undefined
    await wait(
      async () => {
        assert.ok(host)
        const rows = await runs(worker.id)
        const questions = (await call(host, password, root, "GET", "/question")) as Question[]
        pending = questions.find((question) => question.sessionID === rows[0]?.sessionID)
        return (
          rows.length === 1 && rows[0].status === "blocked" && rows[0].blockedReason === "waiting on you" && !!pending
        )
      },
      "The real question did not park its original worker run",
      scheduled ? 90_000 : 60_000,
    )
    const original = (await runs(worker.id))[0]
    assert.ok(original && pending)
    assert.equal(pending.tool?.callID, "call_installed_question")
    const anchor = scheduled ? occurrence(worker.id) : undefined
    if (anchor) {
      assert.equal(anchor.rows.length, 1)
      assert.equal(anchor.rows[0].state, "linked")
      assert.equal(anchor.rows[0].claim_id, original.id)
      assert.equal(anchor.rows[0].session_id, original.sessionID)
      assert.equal(anchor.cursor.length, 1)
      const session = (await call(host, password, root, "GET", `/session/${original.sessionID}`)) as {
        metadata?: {
          rayaRoutine?: {
            version?: number
            runID?: string
            trigger?: { kind?: string; id?: string; scheduledAt?: number; observedAt?: number }
          }
        }
      }
      const identity = session.metadata?.rayaRoutine
      assert.ok(identity)
      assert.equal(identity.version, 2)
      assert.equal(identity.runID, original.id)
      assert.ok(identity.trigger)
      assert.equal(identity.trigger.kind, "timer")
      assert.equal(identity.trigger.id, anchor.rows[0].id)
      assert.equal(identity.trigger.scheduledAt, anchor.rows[0].scheduled_at)
      assert.equal(identity.trigger.observedAt, anchor.rows[0].observed_at)
      assert.equal((await saved(original.sessionID)).completion, undefined)
      stages.push({ stage: "scheduled-original", occurrence: anchor })
    }
    await send(worker.id, `${mode}_followup`, "RECOVERY_FOLLOWUP")
    const continued = await runs(worker.id)
    assert.equal(continued.length, 1)
    assert.equal(continued[0].id, original.id)
    assert.equal(continued[0].sessionID, original.sessionID)
    assert.equal(
      await call(host, password, root, "POST", `/question/${pending.id}/reply`, { answers: [["Proceed"]] }),
      true,
    )
    await bounded(fake.started, 60_000, "The old-intent model turn did not start")
    if (mode === "interrupted") {
      assert.equal(await call(host, password, root, "POST", `/session/${original.sessionID}/abort`), true)
      fake.release()
    }
    const probe: { goal?: Goal; runs?: Run[] } = {}
    stages.push({ stage: "awaiting-recovery", mode, probe })
    try {
      await wait(
        async () => {
          const goal = await saved(original.sessionID)
          probe.goal = goal
          probe.runs = await runs(worker.id)
          return goal.status === "blocked" && goal.replyRecovery?.outcome === mode
        },
        "The old-intent outcome did not enter explicit recovery review",
        60_000,
      )
    } catch (err) {
      const rows = (await call(host, password, root, "GET", `/session/${original.sessionID}/message`)) as Message[]
      const last = rows.toReversed().find((row) => row.info.role === "assistant")
      Object.assign(probe, {
        closes: (trace?.closes ?? []).filter((event) => event.sessionID === original.sessionID),
        assistant: last
          ? {
              id: last.info.id,
              parentID: last.info.parentID,
              error: last.info.error?.name,
              completed: typeof last.info.time?.completed === "number",
              finish: last.info.finish,
            }
          : undefined,
      })
      throw err
    }
    const blocked = await saved(original.sessionID)
    if (scheduled) assert.equal(blocked.completion, undefined)
    const marker = blocked.replyRecovery
    const dispatch = blocked.dispatch
    assert.ok(marker && dispatch)
    assert.equal(marker.version, 1)
    assert.equal(marker.outcome, mode)
    assert.equal(marker.intent, blocked.intent)
    assert.equal(marker.source, `${mode}_followup`)
    assert.equal(marker.dispatchID, dispatch.id)
    assert.equal(marker.messageID, dispatch.messageID)
    assert.equal(marker.oldIntent, dispatch.intent)
    assert.match(marker.execution, /^[a-f0-9]{64}$/)
    assert.ok(Number.isFinite(marker.at))
    assert.equal(marker.reviewedAt, undefined)
    assert.equal(marker.reviewIntent, undefined)
    assert.ok(dispatch.phase === "started" || dispatch.phase === "finished")
    const messages = (await call(host, password, root, "GET", `/session/${original.sessionID}/message`)) as Message[]
    const assistant = dispatch.assistantID
      ? messages.find((row) => row.info.role === "assistant" && row.info.id === dispatch.assistantID)
      : undefined
    const close = trace.closes.findLast(
      (event) => event.sessionID === original.sessionID && event.goalIntent === marker.oldIntent,
    )
    if (dispatch.phase === "finished") {
      assert.equal(dispatch.outcome, mode)
      assert.ok(dispatch.assistantID)
      assert.ok(assistant)
      assert.equal(assistant.info.parentID, dispatch.messageID)
      assert.equal(assistant.info.time?.completed, dispatch.finishedAt)
      assert.ok(close)
      assert.equal(close.reason, mode)
      assert.equal(close.messageID, dispatch.assistantID)
      if (mode === "error") {
        assert.equal(blocked.accounted?.userID, dispatch.messageID)
        assert.ok(blocked.accounted?.messages.includes(dispatch.assistantID))
      } else {
        assert.equal(assistant.info.error?.name, "MessageAbortedError")
        assert.equal(blocked.accounted, undefined)
      }
    } else {
      assert.equal(dispatch.assistantID, undefined)
      assert.equal(dispatch.outcome, undefined)
    }
    const current = await runs(worker.id)
    assert.equal(current.length, 1)
    assert.equal(current[0].id, original.id)
    assert.equal(current[0].sessionID, original.sessionID)
    assert.equal(current[0].status, "running")
    const before = receipts(worker.id)
    stages.push({
      stage: "blocked",
      mode,
      run: current[0],
      goal: blocked,
      close,
      assistant: assistant
        ? {
            id: assistant.info.id,
            parentID: assistant.info.parentID,
            error: assistant.info.error?.name,
            completed: typeof assistant.info.time?.completed === "number",
            finish: assistant.info.finish,
          }
        : undefined,
      receipts: before,
      model: fake.receipt(),
    })
    assert.equal(before.length, scheduled ? 1 : 2)
    if (!scheduled)
      assert.deepEqual(
        before.map((row) => row.source),
        [`${mode}_original`, `${mode}_followup`],
      )
    if (!scheduled) {
      assert.equal(before[0].session_id, original.sessionID)
      assert.notEqual(before[0].delivered_at, null)
    }
    const intake = before[scheduled ? 0 : 1]
    assert.equal(intake.source, `${mode}_followup`)
    assert.equal(intake.session_id, original.sessionID)
    assert.equal(intake.delivery_id, null)
    assert.equal(intake.delivered_at, null)
    const count = fake.count()
    await send(worker.id, `${mode}_followup`, "RECOVERY_FOLLOWUP")
    await Bun.sleep(1_000)
    assert.equal(fake.count(), count)
    await stop(host)
    host = await backend(app, root, env, hosts)
    await call(host, password, root, "GET", "/kilocode/agent")
    await wait(() => host?.markers.revival === true, "Restart did not finish actual routine revival", 45_000)
    await send(worker.id, `${mode}_followup`, "RECOVERY_FOLLOWUP")
    await Bun.sleep(1_000)
    assert.equal(fake.count(), count)
    assert.deepEqual(await saved(original.sessionID), blocked)
    assert.deepEqual(receipts(worker.id), before)
    if (anchor) assert.deepEqual(occurrence(worker.id), anchor)
    await trace.stop()
    trace = undefined
    const leasePath =
      join(storage, "raya", "agent-executions", createHash("sha256").update(original.id).digest("hex")) + ".json"
    const reviewPath =
      join(
        storage,
        "raya",
        "agent-execution-reviews",
        createHash("sha256").update(original.id).digest("hex"),
        marker.execution,
      ) + ".json"
    if (lost) {
      const seen = Promise.withResolvers<Goal>()
      const state = { reading: false, pending: false, closed: false }
      const inspect = () => {
        if (state.closed) return
        if (state.reading) {
          state.pending = true
          return
        }
        state.reading = true
        void saved(original.sessionID)
          .then((goal) => {
            if (
              goal.replyRecovery?.reviewedAt === undefined ||
              goal.replyRecovery.reviewIntent === undefined ||
              state.closed
            )
              return
            state.closed = true
            host!.child.kill("SIGKILL")
            seen.resolve(goal)
            watcher.close()
          })
          .catch((err) => {
            const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown"
            if (code === "ENOENT") {
              state.pending = true
              return
            }
            state.closed = true
            watcher.close()
            seen.reject(new Error(`Goal review watcher read failed (${code})`))
          })
          .finally(() => {
            state.reading = false
            if (!state.closed && state.pending) {
              state.pending = false
              inspect()
            }
          })
      }
      const watcher = watch(join(storage, "raya", "goal"), { persistent: false }, (_event, name) => {
        if (name?.toString() !== `${original.sessionID}.json`) return
        inspect()
      })
      watcher.on("error", () => {
        if (state.closed) return
        state.closed = true
        watcher.close()
        seen.reject(new Error("Goal review watcher failed"))
      })
      const attempt = request(host, password, root, "PATCH", `/session/${original.sessionID}/goal`, {
        status: "active",
        expectedIntent: blocked.intent,
      }).then(
        async (response) => ({ status: response.status, response: await response.json() }),
        (err) => ({ error: err instanceof Error ? err.name : "unknown" }),
      )
      const reviewed = await bounded(
        seen.promise,
        10_000,
        "The persisted review fault boundary was not observed",
      ).finally(() => {
        if (!state.closed) {
          state.closed = true
          watcher.close()
        }
      })
      await stop(host)
      const first = await bounded(attempt, 10_000, "The killed review request did not settle")
      assert.notEqual("status" in first ? first.status : undefined, 200, "The first review response was not lost")
      assert.equal(reviewed.status, "active")
      assert.equal(reviewed.dispatch?.id, marker.dispatchID)
      assert.equal(reviewed.dispatch?.intent, marker.oldIntent)
      assert.equal(reviewed.dispatch?.phase, "finished")
      assert.ok(reviewed.replyRecovery?.reviewedAt)
      assert.ok(reviewed.replyRecovery.reviewIntent)
      assert.equal(reviewed.replyRecovery.execution, marker.execution)
      const immutable = JSON.parse(await readFile(reviewPath, "utf8")) as {
        version?: number
        actor?: string
        record?: { token?: string; runID?: string; agentID?: string; sessionID?: string }
      }
      assert.equal(immutable.version, 1)
      assert.equal(immutable.actor, "user")
      assert.equal(immutable.record?.runID, original.id)
      assert.equal(immutable.record?.agentID, original.agentID)
      assert.equal(immutable.record?.sessionID, original.sessionID)
      assert.equal(
        typeof immutable.record?.token === "string"
          ? createHash("sha256").update(immutable.record.token).digest("hex")
          : undefined,
        marker.execution,
      )
      assert.equal(await Bun.file(leasePath).exists(), false, "A new execution lease means the fault missed resume")
      const history = JSON.parse(
        await readFile(join(storage, "raya", "agent-runs", worker.id) + ".json", "utf8"),
      ) as Run[]
      assert.deepEqual(
        history.find((run) => run.id === original.id),
        current[0],
      )
      assert.equal(fake.count(), count)
      assert.deepEqual(receipts(worker.id), before)
      stages.push({
        stage: "review-response-lost",
        mode,
        first,
        goal: reviewed,
        run: history.find((run) => run.id === original.id),
        review: {
          version: immutable.version,
          actor: immutable.actor,
          run: immutable.record?.runID === original.id,
          agent: immutable.record?.agentID === original.agentID,
          session: immutable.record?.sessionID === original.sessionID,
          digest:
            typeof immutable.record?.token === "string" &&
            createHash("sha256").update(immutable.record.token).digest("hex") === marker.execution,
        },
        execution: false,
        receipts: before,
        model: fake.receipt(),
        owner: host.termination,
      })
      host = await backend(app, root, env, hosts)
      await call(host, password, root, "GET", "/kilocode/agent")
      await wait(() => host?.markers.revival === true, "Restart did not finish lost-review revival", 45_000)
      await wait(
        async () => {
          const rows = await runs(worker.id)
          const goal = await saved(original.sessionID)
          return (
            rows.length === 1 &&
            rows[0].status === "complete" &&
            (scheduled
              ? goal.status === "complete" && !!goal.audit?.verifiedAt
              : goal.reply?.body === "RECOVERY_FOLLOWUP_ACK")
          )
        },
        "The persisted review did not authorize one fresh dispatch after restart",
        60_000,
      )
      assert.equal(fake.count(), count + 1)
      assert.equal(fake.receipt().failures, 1)
      assert.equal(fake.receipt().followups, 1)
    }
    const acknowledged = fake.count()
    const response = await request(host, password, root, "PATCH", `/session/${original.sessionID}/goal`, {
      status: "active",
      expectedIntent: blocked.intent,
    })
    const value = await response.json()
    const lease = (await Bun.file(leasePath).exists())
      ? (JSON.parse(await readFile(leasePath, "utf8")) as {
          token?: string
          runID?: string
          agentID?: string
          sessionID?: string
          state?: string
          owner?: { pid?: number; birth?: string }
        })
      : undefined
    const session = (await call(host, password, root, "GET", `/session/${original.sessionID}`)) as {
      metadata?: { rayaRoutine?: unknown }
    }
    const diagnostic = host.diagnostic.text
      .slice(-4_096)
      .replaceAll(password, "<secret>")
      .replaceAll(fake.url, "<provider>")
      .replaceAll(temp, "<temp>")
      .replaceAll(app.exe, "<executable>")
      .replaceAll(app.dir, "<application>")
      .replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic <secret>")
      .replace(/\b[a-f0-9]{64}\b/gi, "<digest>")
    stages.push({
      stage: "review",
      mode,
      status: response.status,
      response: value,
      goal: await saved(original.sessionID),
      run: (await runs(worker.id)).find((row) => row.id === original.id),
      session: session.metadata?.rayaRoutine,
      execution: lease
        ? {
            state: lease.state,
            run: lease.runID === original.id,
            agent: lease.agentID === original.agentID,
            session: lease.sessionID === original.sessionID,
            digest:
              typeof lease.token === "string" &&
              createHash("sha256").update(lease.token).digest("hex") === marker.execution,
            owner: {
              pid: lease.owner?.pid,
              birth: typeof lease.owner?.birth === "string" && lease.owner.birth.length > 0,
            },
          }
        : undefined,
      review: await Bun.file(reviewPath).exists(),
      diagnostic,
    })
    if (response.status !== 200)
      throw new Error(
        `PATCH /session/${original.sessionID}/goal: ${response.status} ${JSON.stringify(value).slice(0, 512)}`,
      )
    const resumed = value as Goal
    if (scheduled) assert.equal(resumed.completion, undefined)
    assert.equal(resumed.status, lost ? "complete" : "active")
    assert.ok(
      typeof resumed.replyRecovery?.reviewedAt === "number" && Number.isFinite(resumed.replyRecovery.reviewedAt),
    )
    assert.equal(resumed.replyRecovery?.reviewIntent, resumed.intent)
    assert.notEqual(resumed.intent, blocked.intent)
    if (lost) assert.equal(fake.count(), acknowledged)
    await wait(
      async () => {
        const rows = await runs(worker.id)
        const goal = await saved(original.sessionID)
        return (
          rows.length === 1 &&
          rows[0].status === "complete" &&
          (scheduled
            ? goal.status === "complete" && !!goal.audit?.verifiedAt
            : goal.reply?.body === "RECOVERY_FOLLOWUP_ACK")
        )
      },
      "Explicit recovery did not deliver the same-session follow-up",
      60_000,
    )
    const final = await saved(original.sessionID)
    assert.equal((await runs(worker.id))[0].id, original.id)
    assert.equal((await runs(worker.id))[0].sessionID, original.sessionID)
    assert.equal(fake.receipt().followups, 1)
    const delivered = receipts(worker.id)
    assert.equal(delivered.length, scheduled ? 1 : 2)
    const delivery = delivered[scheduled ? 0 : 1]
    assert.equal(delivery.session_id, original.sessionID)
    assert.notEqual(delivery.delivery_id, null)
    assert.notEqual(delivery.delivered_at, null)
    assert.equal(delivery.delivery_id, final.dispatch?.messageID)
    if (anchor) {
      assert.equal(final.completion, undefined)
      assert.equal(final.reply, undefined)
      assert.ok(
        final.audit?.requirements?.some(
          (item) => item.passed && item.evidence.some((proof) => proof.callID === "call_scheduled_read"),
        ),
      )
      assert.equal(fake.receipt().reads, 1)
      assert.equal(fake.receipt().audits, 1)
      assert.equal(fake.receipt().proof, true)
      stages.push({ stage: "scheduled-goal-complete", goal: final, occurrence: occurrence(worker.id) })
      await wait(
        () => occurrence(worker.id).rows[0]?.state === "complete",
        "Verified scheduled recovery did not settle its exact occurrence",
        20_000,
      )
      const settled = occurrence(worker.id)
      assert.deepEqual(settled.cursor, anchor.cursor)
      assert.deepEqual(
        settled.rows,
        anchor.rows.map((row) => ({ ...row, state: "complete" })),
      )
      const count = fake.count()
      await request(host, password, root, "PATCH", `/session/${original.sessionID}/goal`, {
        status: "active",
        expectedIntent: blocked.intent,
      }).then(async (reply) => assert.equal(reply.status, 200))
      await send(worker.id, `${mode}_followup`, "RECOVERY_FOLLOWUP")
      await stop(host)
      host = await backend(app, root, env, hosts)
      await call(host, password, root, "GET", "/kilocode/agent")
      await wait(() => host?.markers.revival === true, "Completed scheduled recovery did not finish revival", 45_000)
      await Bun.sleep(1_000)
      assert.equal(fake.count(), count)
      assert.deepEqual(occurrence(worker.id), settled)
      assert.deepEqual(receipts(worker.id), delivered)
      assert.deepEqual(await saved(original.sessionID), final)
      stages.push({ stage: "scheduled-settled", occurrence: settled })
    }
    if (lost) {
      assert.notEqual(final.dispatch?.id, marker.dispatchID)
      assert.deepEqual(resumed.dispatch, final.dispatch)
      assert.deepEqual(resumed.reply, final.reply)
      assert.deepEqual(resumed.accounted, final.accounted)
      assert.equal(final.replyRecovery?.reviewedAt, resumed.replyRecovery?.reviewedAt)
      assert.equal(final.replyRecovery?.reviewIntent, resumed.replyRecovery?.reviewIntent)
      assert.equal(final.replyRecovery?.execution, marker.execution)
      await Bun.sleep(1_000)
      assert.equal(fake.count(), acknowledged)
      assert.deepEqual(receipts(worker.id), delivered)
    }
    stages.push({ stage: "resolved", mode, goal: final, receipts: delivered, model: fake.receipt() })
    console.log(`Actual ${mode} WAIT recovery acceptance passed: ${app.version}`)
  } catch (err) {
    error = err instanceof assert.AssertionError ? err.message : `Actual ${mode} WAIT recovery failed; inspect receipts`
    throw err
  } finally {
    clearTimeout(timer)
    await trace?.stop()
    const cleanup = await Promise.allSettled(hosts.map(stop))
    fake.server.stop(true)
    await mkdir(join(report, ".."), { recursive: true })
    await writeFile(
      report,
      JSON.stringify(
        {
          version: 1,
          app,
          stages,
          model: fake.receipt(),
          error,
          cleanup: cleanup.map((item, index) => ({
            pid: hosts[index].child.pid,
            joined: item.status === "fulfilled",
            reason: item.status === "fulfilled" ? "joined" : "owned-cleanup-unconfirmed",
            termination: hosts[index].termination,
            startup: [
              "Cannot find package",
              "Unknown argument",
              "Unknown option",
              "SyntaxError",
              "TypeError",
              "ReferenceError",
              "ENOENT",
              "Migration",
            ].filter((value) => hosts[index].diagnostic.text.includes(value)),
          })),
        },
        null,
        2,
      ),
    )
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + sep))
    if (cleanup.every((item) => item.status === "fulfilled")) await rm(temp, { recursive: true, force: true })
    assert.ok(
      cleanup.every((item) => item.status === "fulfilled"),
      "An owned backend did not join; isolated data retained",
    )
  }
}

test(
  "actual runtime retains a terminal nonretryable old-intent WAIT error until explicit recovery",
  () => scenario("error"),
  180_000,
)
test(
  "actual runtime retains an interrupted old-intent WAIT turn until explicit recovery",
  () => scenario("interrupted"),
  180_000,
)
test(
  "actual runtime recovers one lost review response without replaying the old WAIT turn",
  () => scenario("error", true),
  180_000,
)

test(
  "actual runtime reviews a genuine scheduled once WAIT failure without replacing its occurrence",
  () => scenario("error", false, true),
  300_000,
)
