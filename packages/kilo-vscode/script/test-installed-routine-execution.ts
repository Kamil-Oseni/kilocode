import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

type Diagnostic = { text: string; bytes: number; failed: boolean }
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
type Run = { id: string; agentID: string; status: string; sessionID: string }
type Owner = { host: string; pid: number; birth: string }
type Lease = { version: number; agentID: string; runID: string; sessionID: string; token: string; owner: Owner }
type Dispatch = { id: string; messageID: string; phase: string }
type Goal = { status: string; intent?: string; dispatch?: Dispatch }

async function installed() {
  const value = process.env.RAYA_INSTALLED_EXTENSION
  const expected = process.env.RAYA_INSTALLED_VERSION
  assert.ok(value && expected, "Pin RAYA_INSTALLED_EXTENSION and RAYA_INSTALLED_VERSION")
  const dir = resolve(value)
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: string }
  assert.equal(manifest.version, expected)
  assert.match(expected, /^\d+\.\d+\.\d+-snapshot\+[a-f0-9]+\./)
  const exe = join(dir, "bin", "kilo.exe")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(exe, { highWaterMark: 65_536 })) hash.update(chunk)
  return { exe, dir, version: expected, digest: hash.digest("hex") }
}
function fixture() {
  const state = { requests: 0, active: false, cancelled: 0, reason: "" }
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
      if (state.requests !== 1) return new Response("Unexpected additional model request", { status: 503 })
      state.active = true
      const finish = (reason: string) => {
        if (!state.active) return
        state.active = false
        state.cancelled++
        state.reason = reason
        req.signal.removeEventListener("abort", abort)
      }
      const abort = () => finish("request-aborted")
      req.signal.addEventListener("abort", abort, { once: true })
      if (req.signal.aborted) abort()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
          },
          cancel() {
            finish("stream-cancelled")
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
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

async function backend(exe: string, root: string, env: Record<string, string | undefined>, hosts: Host[]) {
  const child = Bun.spawn(
    [exe, "--print-logs", "--log-level", "INFO", "serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: root,
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
    signal: AbortSignal.timeout(35_000),
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
      throw new Error("An owned backend process absence could not be confirmed")
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
  assert.equal(process.platform, "win32")
  const app = await installed()
  const temp = await mkdtemp(join(tmpdir(), "raya-execution-installed-"))
  const root = join(temp, "project")
  const home = join(temp, "home")
  await Promise.all([mkdir(root), mkdir(home)])
  await writeFile(join(root, "README.md"), "Disposable routine ownership acceptance.\n")
  const fake = fixture()
  const env = environment(home, fake.url, randomBytes(32).toString("hex"))
  const password = env.KILO_SERVER_PASSWORD
  const hosts: Host[] = []
  const stages: unknown[] = []
  const report = resolve(
    process.env.RAYA_EXECUTION_REPORT ?? join(import.meta.dir, "../../../.tmp/installed-routine-execution.json"),
  )
  const storage = join(home, ".local", "share", "kilo", "storage")
  const read = async <T>(...parts: string[]) =>
    JSON.parse(await readFile(join(storage, ...parts) + ".json", "utf8")) as T
  let run: Run | undefined
  let error: string | undefined
  const lease = () => {
    assert.ok(run)
    return read<Lease>("raya", "agent-executions", createHash("sha256").update(run.id).digest("hex"))
  }
  const goal = () => {
    assert.ok(run)
    return read<Goal>("raya", "goal", run.sessionID).then((value) => ({
      intent: value.intent,
      status: value.status,
      dispatch: value.dispatch,
    }))
  }
  const record = async (stage: string) => {
    const receipts = run ? await Promise.allSettled([lease(), goal()]) : []
    stages.push({
      stage,
      requests: fake.count(),
      effect: fake.receipt(),
      observations: hosts.map((host) => ({ pid: host.child.pid, ...host.markers })),
      receipts: receipts.map((item) => (item.status === "fulfilled" ? item.value : { unavailable: true })),
    })
  }
  try {
    const first = await backend(app.exe, root, env, hosts)
    const worker = (await call(first, password, root, "POST", "/kilocode/agent", {
      name: "Execution owner",
      objective: "Wait for the synthetic model response.",
      access: "brief",
      tools: [],
      model: { providerID: "test", id: "test-model" },
      schedule: { kind: "manual" },
    })) as { id: string }
    await call(first, password, root, "POST", `/kilocode/agent/${worker.id}/run`)
    await wait(() => fake.count() === 1, "The original owner did not reach the synthetic model", 45_000)
    const runs = (await call(first, password, root, "GET", `/kilocode/agent/${worker.id}/runs`)) as Run[]
    assert.equal(runs.length, 1)
    run = runs[0]
    assert.ok(run)
    assert.equal(run.agentID, worker.id)
    assert.equal(run.status, "running")
    const original = await lease()
    const state = await goal()
    assert.equal(original.version, 1)
    assert.equal(original.agentID, worker.id)
    assert.match(original.token, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
    assert.equal(state.status, "active")
    assert.ok(state.intent)
    await assert.rejects(read("raya", "agent-claims", createHash("sha256").update(worker.id).digest("hex")), {
      code: "ENOENT",
    })
    assert.equal(original.owner.pid, first.child.pid)
    assert.ok(original.owner.birth)
    assert.equal(original.runID, run.id)
    assert.equal(original.sessionID, run.sessionID)
    assert.equal(state.dispatch?.phase, "started")
    assert.ok(state.dispatch.id && state.dispatch.messageID)
    assert.equal(fake.receipt().active, true)
    assert.equal(fake.receipt().cancelled, 0)
    await record("original-started")

    const second = await backend(app.exe, root, env, hosts)
    // The first directory request installs the actual runtime restore subscriptions.
    await call(second, password, root, "GET", "/kilocode/agent")
    await wait(
      () => second.markers.revival && second.markers.failed && second.markers.refused,
      "The second backend's actual ownership refusal was not observed",
      45_000,
    )
    assert.equal(first.child.exitCode, null)
    assert.equal(second.child.exitCode, null)
    assert.equal(fake.count(), 1, "Another live backend replayed the original model dispatch")
    assert.equal(fake.receipt().active, true, "The original streaming model effect did not remain active")
    assert.equal(fake.receipt().cancelled, 0)
    const held = await lease()
    assert.equal(held.token, original.token)
    assert.deepEqual(held.owner, original.owner)
    assert.equal(held.runID, original.runID)
    assert.equal(held.sessionID, original.sessionID)
    const retained = await goal()
    assert.equal(retained.intent, state.intent)
    assert.deepEqual(retained.dispatch, state.dispatch)
    assert.deepEqual(await call(second, password, root, "GET", `/kilocode/agent/${worker.id}/runs`), runs)
    await record("live-owner-refused")

    // Stop both owned transports before a fresh restore; absence alone does not prove the old model succeeded.
    await stop(first)
    await wait(() => fake.receipt().cancelled === 1, "The killed owner's model stream cancellation was not observed")
    assert.equal(fake.receipt().active, false)
    await record("original-effect-cancelled")
    await stop(second)
    const successor = await backend(app.exe, root, env, hosts)
    await call(successor, password, root, "GET", "/kilocode/agent")
    await wait(() => successor.markers.revival, "The successor's actual revival completion was not observed", 45_000)
    assert.equal(successor.markers.failed, false, "The successor's revival failed")
    await wait(
      async () => (await lease()).owner.pid === successor.child.pid,
      "The stopped owner was not recovered",
      45_000,
    )
    const recovered = await lease()
    assert.notEqual(recovered.token, original.token)
    assert.notDeepEqual(recovered.owner, original.owner)
    assert.equal(recovered.runID, original.runID)
    assert.equal(recovered.sessionID, original.sessionID)
    await Bun.sleep(1_000)
    assert.equal(fake.count(), 1, "Stopped-owner recovery replayed an unknown model effect")
    assert.equal(fake.receipt().active, false)
    assert.equal(fake.receipt().cancelled, 1)
    const final = await goal()
    assert.equal(final.intent, state.intent)
    assert.deepEqual(final.dispatch, state.dispatch)
    assert.notEqual(final.status, "complete", "Unknown dispatch was fabricated as completed")
    await record("stopped-owner-no-replay")
    console.log(`Installed routine ownership acceptance passed: ${app.version}`)
  } catch (err) {
    error = err instanceof assert.AssertionError ? err.message : "Installed acceptance failed; inspect stage receipts"
    await record("failed")
    throw err
  } finally {
    const cleanup = await Promise.allSettled(hosts.map(stop))
    fake.server.stop(true)
    await mkdir(join(report, ".."), { recursive: true })
    await writeFile(
      report,
      JSON.stringify(
        {
          version: 1,
          app,
          run,
          stages,
          error,
          cleanup: cleanup.map((item, index) => ({
            pid: hosts[index].child.pid,
            joined: item.status === "fulfilled",
            reason: item.status === "fulfilled" ? "joined" : "owned-cleanup-unconfirmed",
            termination: hosts[index].termination,
            stderrBytes: hosts[index].diagnostic.bytes,
            stderrRetained: hosts[index].diagnostic.text.length,
          })),
        },
        null,
        2,
      ),
    )
    const base = resolve(tmpdir()) + sep
    assert.ok(resolve(temp).startsWith(base))
    if (cleanup.every((item) => item.status === "fulfilled")) await rm(temp, { recursive: true, force: true })
    assert.ok(
      cleanup.every((item) => item.status === "fulfilled"),
      "An owned backend did not join; isolated data retained",
    )
  }
}

await main()
