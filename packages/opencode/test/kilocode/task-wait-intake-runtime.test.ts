import { test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
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
type Dispatch = { id: string; messageID: string; phase: string; intent: string }
type Goal = { status: string; intent?: string; dispatch?: Dispatch; reply?: { messageID: string; body: string } }
type Message = {
  info: { id: string; role: string; parentID?: string; finish?: string; time?: { completed?: number } }
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string; output?: string } }>
}

function installed() {
  return { exe: process.execPath, dir: resolve(import.meta.dir, "../.."), version: "source-runtime" }
}
function fixture() {
  const state = { requests: 0, questions: 0, followupRequests: 0, followupUserRequests: 0 }
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
      if (state.requests > 6) return new Response("Bounded model fixture exhausted", { status: 503 })
      if (body.includes("WAIT_FOLLOWUP")) state.followupRequests++
      const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
      if (
        payload.messages?.some(
          (message) => message.role === "user" && JSON.stringify(message.content)?.includes("WAIT_FOLLOWUP"),
        )
      )
        state.followupUserRequests++
      if (body.includes("WAIT_ORIGINAL") && state.questions === 0) {
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
      return response({
        role: "assistant",
        content: payload.messages?.some(
          (message) => message.role === "user" && JSON.stringify(message.content)?.includes("WAIT_FOLLOWUP"),
        )
          ? "WAIT_FOLLOWUP_ACK"
          : body.includes("WAIT_ORIGINAL")
            ? "OLD_REPLY_ACK"
            : body.includes("COMPLETED_SECOND")
              ? "SECOND_REPLY_ACK"
              : "FIRST_REPLY_ACK",
      })
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/v1`,
    count: () => state.requests,
    receipt: () => ({ ...state }),
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

async function backend(exe: string, env: Record<string, string | undefined>, hosts: Host[]) {
  const child = Bun.spawn(
    [
      exe,
      "run",
      "--cwd",
      resolve(import.meta.dir, "../.."),
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
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
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
  if (response.status !== 200) throw new Error(`${method} ${path}: ${response.status}`)
  return value
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

async function main() {
  const timer = setTimeout(() => lifetime.abort(new Error("Actual runtime acceptance deadline elapsed")), 120_000)
  const app = await installed()
  const temp = await mkdtemp(join(tmpdir(), "raya-followup-installed-"))
  const root = join(temp, "project")
  const home = join(temp, "home")
  await Promise.all([mkdir(root), mkdir(home)])
  await writeFile(join(root, "README.md"), "Disposable installed routine follow-up acceptance.\n")
  const fake = fixture()
  const env = environment(home, fake.url, randomBytes(32).toString("hex"))
  const password = env.KILO_SERVER_PASSWORD
  const hosts: Host[] = []
  const stages: unknown[] = []
  const report = resolve(
    process.env.RAYA_FOLLOWUP_REPORT ?? join(import.meta.dir, "../../../../.tmp/source-routine-followup.json"),
  )
  const storage = join(home, ".local", "share", "kilo", "storage")
  const saved = async (sid: string) => {
    const value = JSON.parse(await readFile(join(storage, "raya", "goal", sid) + ".json", "utf8")) as Goal
    return { status: value.status, intent: value.intent, dispatch: value.dispatch, reply: value.reply }
  }
  let host: Host | undefined
  let error: string | undefined
  const create = async (name: string, tools: string[]) => {
    assert.ok(host)
    return (await call(host, password, root, "POST", "/kilocode/agent", {
      name,
      objective: "Answer this synthetic worker conversation.",
      access: "brief",
      tools,
      model: { providerID: "test", id: "test-model" },
      schedule: { kind: "manual" },
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
  const messages = async (sid: string) => {
    assert.ok(host)
    return (await call(host, password, root, "GET", `/session/${sid}/message`)) as Message[]
  }
  const complete = async (id: string, size: number, text: string) => {
    await wait(
      async () => {
        const rows = await runs(id)
        return rows.length === size && rows.at(-1)?.status === "complete"
      },
      "The actual worker reply did not complete",
      60_000,
    )
    const row = (await runs(id)).at(-1)
    assert.ok(row)
    const goal = await saved(row.sessionID)
    assert.equal(goal.status, "complete")
    assert.equal(goal.reply?.body, text)
    const parts = await messages(row.sessionID)
    const reply = parts.find((message) => message.info.id === goal.reply?.messageID)
    assert.ok(reply)
    assert.equal(reply.info.role, "assistant")
    assert.ok(reply.info.time?.completed)
    assert.ok(reply.parts.some((part) => part.type === "text" && part.text === text))
    const path = join(storage, "raya", "agent-executions", createHash("sha256").update(row.id).digest("hex")) + ".json"
    await wait(
      async () => !(await Bun.file(path).exists()),
      "The completed body did not release execution authority",
      30_000,
    )
    stages.push({ stage: "completed", run: row, goal, model: fake.receipt() })
    return { row, goal, parts }
  }
  try {
    host = await backend(app.exe, env, hosts)
    const worker = await create("Completed follow-up", [])
    await send(worker.id, "completed_first", "COMPLETED_FIRST")
    const first = await complete(worker.id, 1, "FIRST_REPLY_ACK")
    assert.equal(fake.count(), 1)
    await send(worker.id, "completed_second", "COMPLETED_SECOND")
    const second = await complete(worker.id, 2, "SECOND_REPLY_ACK")
    assert.notEqual(second.row.id, first.row.id)
    assert.notEqual(second.row.sessionID, first.row.sessionID)
    assert.deepEqual(await saved(first.row.sessionID), first.goal)
    assert.equal(fake.count(), 2)
    await send(worker.id, "completed_second", "COMPLETED_SECOND")
    await Bun.sleep(1_000)
    assert.equal((await runs(worker.id)).length, 2)
    assert.equal(fake.count(), 2)
    const waiting = await create("Waiting follow-up", ["question"])
    await send(waiting.id, "waiting_first", "WAIT_ORIGINAL")
    type Question = { id: string; sessionID: string; tool?: { callID: string } }
    let pending: Question | undefined
    await wait(
      async () => {
        assert.ok(host)
        const rows = await runs(waiting.id)
        const questions = (await call(host, password, root, "GET", "/question")) as Question[]
        pending = questions.find((question) => question.sessionID === rows[0]?.sessionID)
        return (
          rows.length === 1 && rows[0].status === "blocked" && rows[0].blockedReason === "waiting on you" && !!pending
        )
      },
      "The real question did not park its original worker run",
      60_000,
    )
    const original = (await runs(waiting.id))[0]
    assert.ok(original && pending)
    assert.equal(pending.tool?.callID, "call_installed_question")
    stages.push({
      stage: "waiting",
      run: original,
      question: { id: pending.id, sessionID: pending.sessionID },
      model: fake.receipt(),
    })
    await send(waiting.id, "waiting_followup", "WAIT_FOLLOWUP")
    const continued = await runs(waiting.id)
    assert.equal(continued.length, 1)
    assert.equal(continued[0].id, original.id)
    assert.equal(continued[0].sessionID, original.sessionID)
    assert.equal(
      await call(host, password, root, "POST", `/question/${pending.id}/reply`, { answers: [["Proceed"]] }),
      true,
    )
    const final = await complete(waiting.id, 1, "WAIT_FOLLOWUP_ACK")
    assert.equal(final.row.id, original.id)
    assert.equal(final.row.sessionID, original.sessionID)
    assert.equal(final.goal.dispatch?.intent, final.goal.intent)
    assert.equal(
      final.parts.find((message) => message.info.id === final.goal.reply?.messageID)?.info.parentID,
      final.goal.dispatch?.messageID,
    )
    const tools = final.parts
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "question")
    assert.equal(tools.length, 1)
    assert.equal(tools[0].state?.status, "completed")
    assert.ok(tools[0].state?.output?.includes("Proceed"))
    assert.equal(fake.receipt().questions, 1)
    const ledger = new Sqlite(join(home, "archive-acceptance.db"), { readonly: true })
    try {
      const receipts = ledger
        .query<
          { source: string; session_id: string | null; delivery_id: string | null; delivered_at: number | null },
          [string]
        >("SELECT source, session_id, delivery_id, delivered_at FROM raya_routine_message WHERE agent_id = ? AND kind = 'user' ORDER BY time_created, id")
        .all(waiting.id)
      stages.push({ stage: "same-session-delivery-observed", receipts, model: fake.receipt() })
      assert.ok(fake.receipt().followupRequests > 0, "The model never received the actual follow-up")
      assert.ok(fake.receipt().followupUserRequests > 0, "The follow-up never reached actual model user intake")
      assert.equal(receipts.length, 2)
      assert.deepEqual(
        receipts.map((row) => row.source),
        ["waiting_first", "waiting_followup"],
      )
      assert.ok(receipts.every((row) => row.session_id === original.sessionID && row.delivered_at !== null))
      assert.ok(receipts.every((row) => row.delivery_id !== null))
      assert.notEqual(receipts[0].delivery_id, receipts[1].delivery_id)
      assert.equal(receipts[1].delivery_id, final.goal.dispatch?.messageID)
    } finally {
      ledger.close()
    }
    const count = fake.count()
    await send(waiting.id, "waiting_followup", "WAIT_FOLLOWUP")
    await Bun.sleep(1_000)
    assert.equal((await runs(waiting.id)).length, 1)
    assert.equal(fake.count(), count)
    await stop(host)
    host = await backend(app.exe, env, hosts)
    await call(host, password, root, "GET", "/kilocode/agent")
    await wait(() => host?.markers.revival === true, "Restart did not finish actual routine revival", 45_000)
    assert.equal(host.markers.failed, false)
    await send(waiting.id, "waiting_followup", "WAIT_FOLLOWUP")
    assert.equal(fake.count(), count)
    assert.equal((await runs(waiting.id)).length, 1)
    assert.deepEqual(await saved(original.sessionID), final.goal)
    stages.push({ stage: "restart-duplicate-refused", model: fake.receipt(), goal: final.goal })
    console.log(`Installed routine follow-up acceptance passed: ${app.version}`)
  } catch (err) {
    error = err instanceof assert.AssertionError ? err.message : "Installed follow-up failed; inspect stage receipts"
    throw err
  } finally {
    clearTimeout(timer)
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

test("actual runtime delivers a WAIT worker follow-up once in its original session", main, 240_000)
