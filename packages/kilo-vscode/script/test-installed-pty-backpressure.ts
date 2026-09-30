import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import WebSocket, { type RawData } from "ws"

const commit = process.env.RAYA_PTY_EXPECTED_COMMIT
const sha = process.env.RAYA_PTY_EXPECTED_SHA
const dir = process.env.RAYA_PTY_INSTALLED_EXTENSION
assert.ok(commit && /^[a-f0-9]{10,40}$/.test(commit), "RAYA_PTY_EXPECTED_COMMIT is required")
assert.ok(sha && /^[a-f0-9]{64}$/.test(sha), "RAYA_PTY_EXPECTED_SHA is required")
assert.ok(dir && resolve(dir) === dir, "RAYA_PTY_INSTALLED_EXTENSION must be an absolute installed package path")
const manifest: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
assert.ok(manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string")
assert.ok(manifest.version.includes(`snapshot+${commit}`), "Installed Raya version is not the expected snapshot")
const exe = join(dir, "bin", "kilo.exe")
const hash = createHash("sha256")
for await (const chunk of createReadStream(exe)) hash.update(chunk)
assert.equal(hash.digest("hex"), sha, "Installed CLI bytes changed")

const temp = await mkdtemp(join(tmpdir(), "raya-pty-backpressure-"))
assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + sep))
const project = join(temp, "project")
const state = join(temp, "state")
await Promise.all([mkdir(project), mkdir(state)])
await writeFile(join(project, "README.md"), "Disposable installed PTY backpressure acceptance.\n")
const git = Bun.spawnSync(["git", "init"], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
assert.equal(git.exitCode, 0, git.stderr.toString())
const password = randomBytes(24).toString("hex")
const env = {
  ...process.env,
  HOME: state,
  KILO_TEST_HOME: state,
  XDG_CONFIG_HOME: join(state, ".config"),
  XDG_DATA_HOME: join(state, ".local", "share"),
  XDG_STATE_HOME: join(state, ".local", "state"),
  XDG_CACHE_HOME: join(state, ".cache"),
  KILO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
  KILO_DISABLE_PROJECT_CONFIG: "1",
  KILO_PURE: "1",
  KILO_DISABLE_AUTOUPDATE: "1",
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_AUTH_CONTENT: "{}",
  RAYA_DB: join(state, "pty-backpressure.db"),
  KILO_SERVER_PASSWORD: password,
  RAYA_NO_DAEMON: "1",
  KILO_NO_DAEMON: "1",
}
const child = Bun.spawn([exe, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project,
  env,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  windowsHide: true,
})
const report = {
  version: 1,
  installed: { version: manifest.version, cliSha256: sha },
  scope: { installedCli: true, nativeWindowsPty: process.platform === "win32", renderedVsCode: false },
  backend: { pid: child.pid, exit: null as number | null, stderrTail: "", logTail: "" },
  stall: {
    runtime: "",
    paused: false,
    before: 0,
    settled: 0,
    after: 0,
    durationMs: 0,
    closeCode: null as number | null,
    closeReason: "",
    receivedBytes: 0,
  },
  memory: [] as { elapsedMs: number; workingSet: number; privateBytes: number }[],
  gates: { stalledReader: false, replay: false, memory: false },
  replay: {
    cursor: null as number | null,
    gap: null as unknown,
    receivedBytes: 0,
    settledCursor: 0,
    freshGap: null as unknown,
  },
  cleanup: {
    ptyRemoved: false,
    backendExited: false,
    readerExited: false,
    workspaceRemoved: false,
    processesExited: false,
  },
  failure: "" as string,
  stage: "backend readiness",
}
const path = resolve(import.meta.dir, "../../../.tmp", `installed-pty-backpressure-${commit}.json`)
const auth = `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`
let url = ""
let pty = ""
let slow: ReturnType<typeof Bun.spawn> | undefined
let actor = 0
const node = Bun.which("node")
assert.ok(node, "Node is required for a real stalled socket reader")
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, label: string) {
  let size = 0
  let tail = ""
  while (true) {
    const item = await reader.read()
    if (item.done) return tail
    size += item.value.byteLength
    if (size > 2_000_000) throw new Error(`${label} exceeded its diagnostic bound`)
    tail = (tail + new TextDecoder().decode(item.value)).slice(-1200)
  }
}
const stderr = drain(child.stderr.getReader(), "Installed backend stderr")
void stderr.catch(() => child.kill("SIGKILL"))

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function frame(data: RawData) {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

async function ready() {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (output.length < 100_000) {
    const next = await bounded(reader.read(), 60_000, "Installed backend readiness")
    if (next.done) throw new Error(`Installed backend exited before readiness: ${(await stderr).slice(-1200)}`)
    output += decoder.decode(next.value)
    const match = output.match(/listening on (http:\/\/[^\s]+)/)
    if (match) {
      void drain(reader, "Installed backend stdout").catch(() => child.kill("SIGKILL"))
      return match[1]
    }
  }
  throw new Error("Installed backend readiness output exceeded its bound")
}

async function request(method: string, route: string, body?: unknown) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: {
      Authorization: auth,
      "x-kilo-directory": project,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok)
    throw new Error(`${method} ${route} returned ${response.status}: ${(await response.text()).slice(0, 500)}`)
  return response
}

async function powershell(source: string) {
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const output = drain(proc.stdout.getReader(), "Process sampling stdout")
  const errors = drain(proc.stderr.getReader(), "Process sampling stderr")
  try {
    assert.equal(await bounded(proc.exited, 30_000, "Process sample"), 0, await errors)
    return await output
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL")
    await bounded(proc.exited, 15_000, "Sampling process cleanup")
  }
}

async function usage(pid: number) {
  const result: unknown = JSON.parse(
    await powershell(
      `$task = Get-Process -Id ${pid} -ErrorAction Stop; @{workingSet=$task.WorkingSet64;privateBytes=$task.PrivateMemorySize64} | ConvertTo-Json -Compress`,
    ),
  )
  assert.ok(result && typeof result === "object" && "workingSet" in result && "privateBytes" in result)
  assert.ok(typeof result.workingSet === "number" && typeof result.privateBytes === "number")
  return { workingSet: result.workingSet, privateBytes: result.privateBytes }
}

async function absent(pids: number[]) {
  return (await powershell(`@(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue).Count`)).trim() === "0"
}

async function metadata(cursor: number) {
  const ws = new WebSocket(
    `${url.replace(/^http/, "ws")}/pty/${pty}/connect?directory=${encodeURIComponent(project)}&cursor=${cursor}`,
    { headers: { Authorization: auth }, perMessageDeflate: false },
  )
  let received = 0
  try {
    const result = new Promise<{
      cursor: number
      replayGap?: { requestedCursor: number; retainedFrom: number; retainedTo: number }
    }>((resolve, reject) => {
      ws.on("message", (data) => {
        const bytes = frame(data)
        if (bytes[0] !== 0) {
          received += bytes.byteLength
          return
        }
        try {
          resolve(JSON.parse(bytes.subarray(1).toString("utf8")))
        } catch (error) {
          reject(error)
        }
      })
      ws.once("error", reject)
      ws.once("close", (code) => reject(new Error(`PTY closed before metadata: ${code}`)))
    })
    return { meta: await bounded(result, 30_000, "PTY metadata"), received }
  } finally {
    ws.terminate()
  }
}

try {
  assert.equal(process.platform, "win32", "This acceptance harness is for native Windows PTY")
  url = await ready()
  report.stage = "native PTY creation"
  const source = [
    "const chunk = Buffer.alloc(64 * 1024, 0x78)",
    "let started = false",
    'process.stdin.on("data", () => {',
    "  if (started) return",
    "  started = true",
    "  void (async () => {",
    "    for (let n = 0; n < 320; n++) await new Promise((resolve) => process.stdout.write(chunk, resolve))",
    '    process.stdout.write("RAYA_FLOOD_COMPLETE\\n")',
    "    setInterval(() => {}, 1000)",
    "  })()",
    "})",
  ].join("\n")
  const created = await request("POST", "/pty", {
    command: process.execPath,
    args: ["-e", source],
    cwd: project,
    title: "Disposable installed PTY flood",
    size: { cols: 80, rows: 24 },
  })
  const info: unknown = await created.json()
  assert.ok(info && typeof info === "object" && "id" in info && typeof info.id === "string")
  pty = info.id
  assert.ok(pty.startsWith("pty_"), "PTY create did not return an ID")

  assert.ok("pid" in info && typeof info.pid === "number")
  actor = info.pid
  const started = Date.now()
  report.memory.push({ elapsedMs: 0, ...(await usage(child.pid)) })
  report.stage = "stalled Node reader"
  const reader = Bun.spawn([node, join(import.meta.dir, "pty-stalled-reader.cjs")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  slow = reader
  reader.stdin.write(
    JSON.stringify({
      url: `${url.replace(/^http/, "ws")}/pty/${pty}/connect?directory=${encodeURIComponent(project)}&cursor=-1`,
      auth,
    }),
  )
  reader.stdin.end()
  const sampling = (async () => {
    for (let n = 0; n < 8 && slow?.exitCode === null; n++) {
      const sample = await usage(child.pid)
      report.memory.push({ elapsedMs: Date.now() - started, ...sample })
      await Bun.sleep(500)
    }
  })().then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  const output = drain(reader.stdout.getReader(), "Node reader stdout")
  const errors = drain(reader.stderr.getReader(), "Node reader stderr")
  const code = await bounded(slow.exited, 50_000, "Stalled Node reader exit")
  const sampled = await sampling
  const diagnostic = await errors
  const result = await output
  if (result.trim()) report.stall = JSON.parse(result) as typeof report.stall
  assert.equal(code, 0, diagnostic)
  assert.equal(sampled, "", "Memory sampling failed")
  const closed = report.stall
  assert.equal(closed.paused, true, "Reader did not pause its socket")
  assert.ok(closed.durationMs >= 2500, "Reader stall was too short")
  assert.ok(closed.settled - closed.before <= 64 * 1024, "Node reader prefetch exceeded its bound")
  assert.equal(closed.after, closed.settled, "Node transport read bytes after pause settled")
  assert.equal(closed.closeCode, 1013, `Expected bounded backlog close, got ${closed.closeCode} ${closed.closeReason}`)
  assert.equal(closed.closeReason, "terminal output backlog")
  report.gates.stalledReader = true
  report.stage = "output settlement and replay"

  let stable = 0
  let previous = -1
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && stable < 3) {
    const tail = await metadata(-1)
    stable = tail.meta.cursor > 2 * 1024 * 1024 && tail.meta.cursor === previous ? stable + 1 : 0
    previous = tail.meta.cursor
    await Bun.sleep(250)
  }
  assert.equal(stable, 3, "PTY output did not settle beyond the retained replay bound")
  report.replay.settledCursor = previous

  const replay = await metadata(0)
  const meta = replay.meta
  report.replay.cursor = meta.cursor
  report.replay.gap = meta.replayGap ?? null
  report.replay.receivedBytes = replay.received
  const gap = meta.replayGap
  assert.equal(gap?.requestedCursor, 0)
  assert.ok((gap?.retainedFrom ?? 0) > 0, "Stale reconnect did not report the retained output gap")
  assert.equal(gap?.retainedTo, meta.cursor)
  assert.equal(replay.received, meta.cursor - gap.retainedFrom, "Replay bytes do not match the declared retained range")
  const fresh = await metadata(gap.retainedFrom)
  report.replay.freshGap = fresh.meta.replayGap ?? null
  assert.equal(fresh.meta.replayGap, undefined, "Exact retained cursor falsely reported a gap")
  assert.equal(fresh.received, fresh.meta.cursor - gap.retainedFrom)
  report.gates.replay = true
  report.memory.push({ elapsedMs: Date.now() - started, ...(await usage(child.pid)) })
  report.stage = "memory bound"
  for (const sample of report.memory) {
    assert.ok(
      sample.workingSet < 1024 * 1024 * 1024 && sample.privateBytes < 1024 * 1024 * 1024,
      `Backend exceeded 1 GiB smoke-test memory bound: ${JSON.stringify(sample)}`,
    )
  }
  report.gates.memory = true
  report.stage = "completed"
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
} finally {
  if (slow?.exitCode === null) slow.kill("SIGKILL")
  report.cleanup.readerExited = slow ? (await bounded(slow.exited, 15_000, "Node reader cleanup")) !== null : true
  if (report.failure) await Bun.sleep(500)
  if (pty && url) {
    const removed = await request("DELETE", `/pty/${pty}`).then(
      () => true,
      () => false,
    )
    report.cleanup.ptyRemoved = removed
  }
  if (child.exitCode === null) child.kill("SIGKILL")
  report.backend.exit = await bounded(child.exited, 15_000, "Owned backend exit").catch(() => null)
  report.cleanup.backendExited = report.backend.exit !== null
  report.cleanup.processesExited = await absent([child.pid, actor].filter((pid) => pid > 0)).catch((error: unknown) => {
    report.failure ||= error instanceof Error ? error.message : String(error)
    return false
  })
  report.backend.stderrTail = await bounded(stderr, 15_000, "Owned backend stderr drain").catch(() => "")
  const logs = join(state, ".local", "share", "kilo", "log")
  const names = await readdir(logs).catch(() => [])
  const name = names
    .filter((item) => item.endsWith(".log"))
    .sort()
    .at(-1)
  if (name)
    report.backend.logTail = (await readFile(join(logs, name), "utf8"))
      .split("\n")
      .filter((line) => /level=(?:ERROR|WARN)/.test(line))
      .slice(-8)
      .join("\n")
      .slice(-4000)
  await rm(temp, { recursive: true, force: true })
  report.cleanup.workspaceRemoved = true
  await mkdir(resolve(import.meta.dir, "../../../.tmp"), { recursive: true })
  await writeFile(path, JSON.stringify(report, null, 2) + "\n")
  console.log(path)
  console.log(
    JSON.stringify({ failure: report.failure, stall: report.stall, replay: report.replay, cleanup: report.cleanup }),
  )
}

if (report.failure) throw new Error(report.failure)
assert.equal(report.cleanup.ptyRemoved, true)
assert.equal(report.cleanup.backendExited, true)
assert.equal(report.cleanup.readerExited, true)
assert.equal(report.cleanup.processesExited, true)
