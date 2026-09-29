#!/usr/bin/env bun
// Installed CLI and isolated headless browser transport only; no desktop capture or input.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"

const root = resolve(import.meta.dir, "../../..")
const installed = process.env.RAYA_BROWSER_INSTALLED_CLI
const expected = process.env.RAYA_BROWSER_INSTALLED_SHA?.toLowerCase()
const source = process.env.RAYA_BROWSER_SNAPSHOT_RECEIPT
const interval = 1_000
const timeout = 360_000
assert.ok(process.platform === "win32", "Installed resource sampling requires Windows")
assert.ok(installed && expected && /^[\da-f]{64}$/.test(expected), "Pass installed CLI path and independent SHA-256")
assert.ok(source, "Pass the independently verified installed snapshot receipt")
if (process.env.RAYA_BROWSER_INSTALLED_RECEIPT)
  assert.equal(resolve(process.env.RAYA_BROWSER_INSTALLED_RECEIPT).toLowerCase(), resolve(source).toLowerCase())
const snapshot = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>
assert.equal(resolve(installed).toLowerCase(), resolve(String(snapshot.installed), "bin", "kilo.exe").toLowerCase())
assert.equal(expected, snapshot.cliSha256)
assert.ok(typeof snapshot.verifiedFiles === "number" && snapshot.verifiedFiles > 0)
const hash = createHash("sha256")
for await (const chunk of createReadStream(installed)) hash.update(chunk)
assert.equal(hash.digest("hex"), expected, "Installed CLI differs from the independently checked package")

const stamp = `${Date.now()}-${process.pid}`
const report = resolve(root, ".tmp", `installed-browser-resource-${stamp}.json`)
const workflow = resolve(root, ".tmp", `installed-browser-resource-${stamp}-workflow.json`)
type Kind = "worker" | "backend" | "restarted_backend"
type Point = { atMs: number; start: string; cpuSeconds: number; rss: number; privateBytes: number; handles: number }
type Track = { kind: Kind; pid: number; discoveredMs: number; endedMs?: number; samples: Point[]; missing: number }
const tracks: Track[] = []
const failures: string[] = []
const probes: number[] = []
const wall = Date.now()
const started = performance.now()
let ended = false
let timedOut = false
function record(phase: Kind | "backend_exited", worker: number, backend?: number) {
  if (phase === "worker") {
    tracks.push({ kind: "worker", pid: worker, discoveredMs: performance.now() - started, samples: [], missing: 0 })
    return
  }
  if (!backend || !Number.isSafeInteger(backend)) return
  if (phase === "backend_exited") {
    const prior = tracks.find((track) => track.kind === "backend" && track.pid === backend)
    if (prior) prior.endedMs = performance.now() - started
    return
  }
  if (tracks.some((track) => track.kind === phase || track.pid === backend)) {
    failures.push("Owned backend identity was duplicated")
    return
  }
  if (phase === "restarted_backend") {
    const prior = tracks.find((track) => track.kind === "backend")
    if (prior) prior.endedMs = performance.now() - started
  }
  tracks.push({ kind: phase, pid: backend, discoveredMs: performance.now() - started, samples: [], missing: 0 })
}
const child = Bun.spawn([process.execPath, join(import.meta.dir, "test-browser-workflow-runtime.ts")], {
  cwd: resolve(root, "packages", "kilo-vscode"),
  env: {
    ...process.env,
    RAYA_BROWSER_RESOURCE: "1",
    RAYA_BROWSER_REPORT: workflow,
    RAYA_BROWSER_INSTALLED_RECEIPT: source,
  },
  stdout: "pipe",
  stderr: "pipe",
  windowsHide: true,
  serialization: "json",
  ipc(value: unknown) {
    if (!value || typeof value !== "object" || !("phase" in value) || !("version" in value)) return
    if (value.version !== 1 || !("pid" in value) || value.pid !== child.pid) return
    if (!(["worker", "backend", "backend_exited", "restarted_backend"] as unknown[]).includes(value.phase)) return
    if (!("worker" in value) || typeof value.worker !== "number" || !Number.isSafeInteger(value.worker)) return
    const backend = "backend" in value && typeof value.backend === "number" ? value.backend : undefined
    record(value.phase as Kind | "backend_exited", value.worker, backend)
  },
})
const diagnostic = { stdout: "", stderr: "" }
const drains = [child.stdout, child.stderr].map(async (stream, index) => {
  const key = index === 0 ? "stdout" : "stderr"
  for await (const chunk of stream)
    diagnostic[key] = (diagnostic[key] + Buffer.from(chunk).toString("utf8")).slice(-4_096)
})
const cmd = `$ErrorActionPreference='Stop';while($true){$line=[Console]::In.ReadLine();if($null -eq $line){break};$ids=@($line.Split(',')|ForEach-Object{[int]$_});$rows=@(foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{pid=$id;path=$p.Path;start=$p.StartTime.ToUniversalTime().Ticks.ToString();cpuSeconds=[double]$p.CPU;rss=[double]$p.WorkingSet64;privateBytes=[double]$p.PrivateMemorySize64;handles=[int]$p.Handles}}});[Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress));[Console]::Out.Flush()}`
const probe = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
})
probe.on("error", () => failures.push("Owned process sampler failed to start"))
probe.stdin.on("error", () => failures.push("Owned process sampler input closed"))
const lines = createInterface({ input: probe.stdout })[Symbol.asyncIterator]()
const probeExit = new Promise<number | null>((done) => probe.once("exit", (code) => done(code)))

async function sample() {
  const active = tracks.filter((track) => track.endedMs === undefined)
  if (!active.length) return
  const ids = active.map((track) => track.pid).join(",")
  const began = performance.now()
  probe.stdin.write(ids + "\n")
  const reply = await Promise.race([lines.next(), Bun.sleep(5_000).then(() => undefined)])
  if (!reply || reply.done) {
    failures.push("Owned process sampler failed")
    probe.kill()
    return
  }
  probes.push(performance.now() - began)
  const parsed = JSON.parse(reply.value) as unknown
  const rows = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) as Array<
    Omit<Point, "atMs"> & { pid: number; path: string }
  >
  for (const track of active) {
    const row = rows.find((item) => item.pid === track.pid)
    if (!row) {
      track.missing++
      continue
    }
    if (typeof row.path !== "string") {
      failures.push(`Owned ${track.kind} executable path is unavailable`)
      continue
    }
    if (track.kind !== "worker" && resolve(row.path).toLowerCase() !== resolve(installed).toLowerCase()) {
      failures.push(`Owned ${track.kind} executable identity changed`)
      continue
    }
    const born = Number(row.start) / 10_000 - 62_135_596_800_000
    if (!Number.isFinite(born) || born < wall - 5_000 || born > Date.now() + 5_000) {
      failures.push(`Owned ${track.kind} PID predates this gate`)
      continue
    }
    if (
      ![row.cpuSeconds, row.rss, row.privateBytes, row.handles].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    ) {
      failures.push(`Owned ${track.kind} sample is invalid`)
      continue
    }
    if (track.samples.length && track.samples[0].start !== row.start) {
      failures.push(`Owned ${track.kind} PID changed identity`)
      continue
    }
    track.samples.push({
      atMs: performance.now() - started,
      start: row.start,
      cpuSeconds: row.cpuSeconds,
      rss: row.rss,
      privateBytes: row.privateBytes,
      handles: row.handles,
    })
  }
}

function percent(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}
function timing(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0)
  assert.equal(valid.length, values.length, "Timing contains invalid values")
  return { count: valid.length, p50Ms: percent(valid, 0.5), p95Ms: percent(valid, 0.95), maxMs: Math.max(...valid) }
}
function measure(track: Track) {
  const first = track.samples[0]
  const last = track.samples.at(-1)
  const span = last && first ? (last.atMs - first.atMs) / 1000 : 0
  const cpu = last && first && span > 0 ? ((last.cpuSeconds - first.cpuSeconds) / span) * 100 : null
  const gaps = track.samples.slice(1).map((sample, index) => sample.atMs - track.samples[index].atMs)
  return {
    kind: track.kind,
    pid: track.pid,
    discoveredMs: track.discoveredMs,
    endedMs: track.endedMs,
    count: track.samples.length,
    missing: track.missing,
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    cpuCorePercent: cpu,
    cpuMachinePercent: cpu === null ? null : cpu / availableParallelism(),
    rss: {
      first: first?.rss,
      last: last?.rss,
      growth: first && last ? last.rss - first.rss : null,
      max: Math.max(...track.samples.map((sample) => sample.rss)),
    },
    privateBytes: {
      first: first?.privateBytes,
      last: last?.privateBytes,
      growth: first && last ? last.privateBytes - first.privateBytes : null,
      max: Math.max(...track.samples.map((sample) => sample.privateBytes)),
    },
    handles: {
      first: first?.handles,
      last: last?.handles,
      growth: first && last ? last.handles - first.handles : null,
      max: Math.max(...track.samples.map((sample) => sample.handles)),
    },
  }
}

const expiry = Promise.withResolvers<void>()
const cleanup = {
  killed: false,
  killJoined: true,
  streamsJoined: false,
  runnerJoined: false,
  samplerJoined: false,
  samplerAbsent: false,
}
const timer = setTimeout(() => {
  timedOut = true
  failures.push("Installed headless resource gate exceeded its bounded lifetime")
  expiry.resolve()
}, timeout)
const polling = (async () => {
  while (!ended && !timedOut) {
    await sample().catch(() => failures.push("Owned process sample was unavailable"))
    await Bun.sleep(interval)
  }
})()
const code = await (async () => {
  const first = await Promise.race([
    child.exited.then((code) => ({ code })),
    expiry.promise.then(() => ({ code: undefined })),
  ])
  if (first.code !== undefined) return first.code
  if (child.exitCode !== null) return child.exited
  cleanup.killed = true
  const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const result = await Promise.race([kill.exited, Bun.sleep(10_000).then(() => undefined)])
  cleanup.killJoined = result !== undefined && result === 0
  if (!cleanup.killJoined) failures.push("Owned tree termination did not finish successfully")
  return Promise.race([child.exited, Bun.sleep(15_000).then(() => undefined)])
})()
ended = true
clearTimeout(timer)
cleanup.runnerJoined = code !== undefined
cleanup.streamsJoined =
  (await Promise.race([Promise.all([polling, ...drains]).then(() => true), Bun.sleep(10_000).then(() => false)])) ===
  true
if (!cleanup.streamsJoined) failures.push("Owned runner output or sampler did not join")
probe.stdin.end()
const stopped = await Promise.race([probeExit, Bun.sleep(5_000).then(() => undefined)])
if (stopped === undefined) probe.kill()
cleanup.samplerJoined =
  stopped !== undefined || (await Promise.race([probeExit.then(() => true), Bun.sleep(5_000).then(() => false)]))
if (!cleanup.samplerJoined) failures.push("Owned process sampler did not exit")
if (probe.pid) {
  try {
    process.kill(probe.pid, 0)
    failures.push("Owned process sampler remains alive")
  } catch (err) {
    cleanup.samplerAbsent = !!(err && typeof err === "object" && "code" in err && err.code === "ESRCH")
    if (!cleanup.samplerAbsent) failures.push("Owned process sampler absence is unproved")
  }
}
if (code === undefined) failures.push("Owned runner did not exit after bounded tree termination")
if (code !== 0) failures.push(`Installed workflow exited ${code}`)
if (code !== 0) {
  const tail = `${diagnostic.stdout}\n${diagnostic.stderr}`
    .replace(/Basic [A-Za-z0-9+/=]+/g, "Basic [redacted]")
    .replace(/(?:api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(-4_000)
  if (tail) console.error(tail)
}
const data = await readFile(workflow, "utf8").then(
  (value) => JSON.parse(value) as Record<string, unknown>,
  () => undefined,
)
if (!data) failures.push("Installed workflow receipt is missing")
const runner = workflow.slice(0, -5) + "-runner.json"
const receipt = await readFile(runner, "utf8").then(
  (value) => JSON.parse(value) as Record<string, unknown>,
  () => undefined,
)
if (
  !receipt ||
  receipt.pid !== tracks.find((track) => track.kind === "worker")?.pid ||
  receipt.retired !== true ||
  receipt.joined !== true ||
  receipt.absent !== true ||
  receipt.fallback !== false ||
  (receipt.owner as { report?: string } | undefined)?.report !== workflow
)
  failures.push("Owned workflow runner retirement is unproved")
const retired = data?.cleanup as Record<string, unknown> | undefined
if (
  !retired ||
  retired.browser !== true ||
  retired.sse !== true ||
  retired.servers !== true ||
  retired.streams !== true ||
  retired.absent !== true ||
  !Array.isArray(data?.retirement) ||
  data.retirement.some((item) => item !== "fulfilled")
)
  failures.push("Installed workflow resources did not all retire")
try {
  process.kill(child.pid, 0)
  failures.push("Owned workflow runner is still alive")
} catch (err) {
  if (!(err && typeof err === "object" && "code" in err && err.code === "ESRCH"))
    failures.push("Owned workflow runner absence is unproved")
}
for (const track of tracks) {
  try {
    process.kill(track.pid, 0)
    failures.push(`Owned ${track.kind} remains alive after retirement`)
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ESRCH"))
      failures.push(`Owned ${track.kind} absence is unproved`)
  }
}
const cases = data?.cases as Record<string, { service: number[]; roundtrip: number[]; prompt?: number }> | undefined
const dispatch = data?.dispatch as Array<{ operation: string; ms: number; outcome: string }> | undefined
const stages =
  cases && dispatch
    ? {
        service: timing(Object.values(cases).flatMap((item) => item.service)),
        roundtrip: timing(Object.values(cases).flatMap((item) => item.roundtrip)),
        prompt: timing(Object.values(cases).flatMap((item) => (item.prompt === undefined ? [] : [item.prompt]))),
        browserDispatch: timing(dispatch.map((item) => item.ms)),
      }
    : undefined
if (!stages || Object.values(stages).some((item) => item.count < 1))
  failures.push("Installed timing stages lack observations")
if (
  !Array.isArray(dispatch) ||
  dispatch.filter((item) => item.operation === "click" && item.outcome === "confirmed").length !== 1
)
  failures.push("Installed workflow did not confirm exactly one click")
const summary = tracks.map(measure)
for (const row of summary) {
  if (row.count < 2 || row.maxGapMs === null || row.maxGapMs > 5_000)
    failures.push(`Owned ${row.kind} sampling coverage failed`)
  if (row.missing > 1) failures.push(`Owned ${row.kind} disappeared before expected retirement`)
  if (row.rss.max > 1_500_000_000 || row.privateBytes.max > 2_000_000_000 || row.handles.max > 10_000)
    failures.push(`Owned ${row.kind} exceeded the bounded resource ceiling`)
}
if (summary.length !== 3) failures.push("Owned worker and both backend processes were not observed")
if (timedOut) failures.push("Gate timed out")
const result = {
  format: "raya.installed-headless-browser-resources",
  version: 1,
  scope:
    "one bounded installed CLI and isolated headless Chromium workflow; no loaded VS Code, native desktop, or prolonged-use claim",
  resourceScope: "owned Node bridge worker and two installed CLI backends; Chromium subprocess resources unmeasured",
  status: failures.length ? "failed" : "passed",
  binary: { path: installed, sha256: expected },
  snapshot: { receipt: source, commit: snapshot.commit, packageSha256: snapshot.packageSha256 },
  intervalMs: interval,
  safetyTimeoutMs: timeout,
  observationMs: performance.now() - started,
  elapsedMs: performance.now() - started,
  processes: summary,
  sampler: {
    pid: probe.pid,
    probes: timing(probes),
    instrumented: true,
    note: "PowerShell probe overhead is included in the observed workload; these are not unperturbed latency samples",
  },
  cleanup,
  stages,
  stageMeaning: {
    service: "Loopback model response preparation; excludes real model inference",
    roundtrip: "Tool issuance to next loopback provider request across actual backend, SDK, SSE, and host",
    prompt: "Whole installed CLI session prompt",
    browserDispatch: "Production BrowserSession host.execute wall time including pacing and grounding",
  },
  workflow,
  runner,
  resourceLimit: "Ceilings are failure sanity checks, not evidence of a memory or handle leak plateau",
  failures,
  desktopCapture: false,
  telemetry: false,
  rawFrames: false,
}
await mkdir(resolve(root, ".tmp"), { recursive: true })
await writeFile(report, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ status: result.status, report, failures }))
if (failures.length) process.exitCode = 2
