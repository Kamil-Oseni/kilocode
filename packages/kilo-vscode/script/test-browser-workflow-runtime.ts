import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

async function bounded<T>(promise: Promise<T>, ms: number, detail: string) {
  const state: { timer?: ReturnType<typeof setTimeout> } = {}
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      state.timer = setTimeout(() => reject(new Error(detail)), ms)
    }),
  ]).finally(() => clearTimeout(state.timer))
}
const root = resolve(import.meta.dir, "..")
const repo = resolve(root, "../..")
if (process.env.RAYA_BROWSER_RESOURCE === "1")
  assert.equal(typeof process.send, "function", "Resource gate needs parent IPC")
const base = join(root, "tmp")
await mkdir(base, { recursive: true })
const dir = await mkdtemp(join(base, "browser-workflow-"))
assert.ok(resolve(dir).startsWith(resolve(base) + sep))
const build = await Bun.build({
  entrypoints: [join(root, "tests", "integration", "browser-workflow-runtime.ts")],
  outdir: dir,
  target: "node",
  format: "cjs",
  external: ["playwright-core"],
})
assert.ok(build.success, build.logs.map(String).join("\n"))
assert.ok(build.outputs[0]?.path)
const state: {
  expired: boolean
  fallback: boolean
  bytes: number
  retired: boolean
  owner?: { root: string; report: string }
  error?: string
  absent?: boolean
  joined?: boolean
} = { expired: false, fallback: false, bytes: 0, retired: false }
function forward(value: unknown, runner: number, worker: number) {
  if (process.env.RAYA_BROWSER_RESOURCE !== "1" || !state.owner) return
  if (!value || typeof value !== "object" || !("phase" in value)) return
  if (value.phase === "owner") {
    process.send?.({ version: 1, phase: "worker", pid: runner, worker })
    return
  }
  if (value.phase !== "backend" && value.phase !== "backend_exited" && value.phase !== "restarted_backend") return
  if (!("backend" in value) || typeof value.backend !== "number" || !Number.isSafeInteger(value.backend)) return
  if (value.backend < 1) return
  process.send?.({ version: 1, phase: value.phase, pid: runner, worker, backend: value.backend })
}
const child = Bun.spawn(["node", build.outputs[0].path], {
  cwd: root,
  env: { ...process.env, RAYA_BROWSER_REPO: repo, RAYA_BROWSER_BUN: process.execPath },
  stdout: "pipe",
  stderr: "pipe",
  windowsHide: true,
  serialization: "json",
  ipc(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("pid" in value) ||
      value.pid !== child.pid ||
      !("phase" in value)
    )
      return
    if (
      value.phase === "owner" &&
      "root" in value &&
      typeof value.root === "string" &&
      "report" in value &&
      typeof value.report === "string"
    ) {
      assert.ok(resolve(value.root).startsWith(resolve(tmpdir()) + sep))
      assert.ok(resolve(value.report).startsWith(resolve(repo, ".tmp") + sep))
      state.owner = { root: value.root, report: value.report }
    }
    forward(value, process.pid, child.pid)
    if (
      value.phase === "retired" &&
      "joined" in value &&
      value.joined === true &&
      "report" in value &&
      value.report === state.owner?.report
    )
      state.retired = true
  },
})
const drains = [child.stdout, child.stderr].map(async (stream) => {
  for await (const value of stream) {
    state.bytes += value.length
    if (state.bytes <= 32_768) process.stdout.write(value)
  }
})
const timer = setTimeout(() => {
  state.expired = true
  if (child.exitCode === null) child.send({ phase: "stop" })
}, 250_000)
try {
  const code = await bounded(child.exited, 285_000, "Owned runner did not retire after graceful cancellation")
  await bounded(Promise.all(drains), 10_000, "Owned runner output did not join")
  state.joined = true
  assert.equal(state.expired, false, "Owned integration exceeded its lifetime")
  assert.equal(code, 0, "Actual browser workflow failed; inspect retained receipt")
  assert.ok(state.retired && state.owner, "Owned resource retirement was not acknowledged")
} catch (err) {
  state.error = err instanceof Error ? err.message : "Browser runner failed"
  throw err
} finally {
  clearTimeout(timer)
  if (child.exitCode === null) {
    child.send({ phase: "stop" })
    const graceful = await bounded(child.exited, 35_000, "Graceful child retirement expired").then(
      () => true,
      () => false,
    )
    // Only this still-live owned child establishes PID identity for a descendant tree kill.
    if (!graceful && child.exitCode === null) {
      state.fallback = true
      if (process.platform === "win32") {
        const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        await bounded(kill.exited, 10_000, "Owned tree termination did not finish")
      } else child.kill("SIGKILL")
    }
  }
  const joined = await Promise.allSettled([
    bounded(child.exited, 15_000, "Owned child exit unconfirmed"),
    bounded(Promise.all(drains), 10_000, "Owned output join unconfirmed"),
  ])
  state.joined = joined.every((item) => item.status === "fulfilled")
  try {
    process.kill(child.pid, 0)
    state.absent = false
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") state.absent = true
    else throw err
  }
  await mkdir(join(repo, ".tmp"), { recursive: true })
  const receipt = state.owner?.report.endsWith(".json")
    ? state.owner.report.slice(0, -5) + "-runner.json"
    : join(repo, ".tmp", "source-browser-workflow-runner.json")
  await writeFile(receipt, JSON.stringify({ version: 1, pid: child.pid, ...state }, null, 2))
  assert.ok(resolve(dir).startsWith(resolve(base) + sep))
  if (state.joined && state.absent) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  assert.ok(
    state.joined && state.absent && state.retired && !state.fallback,
    "Owned cleanup is incomplete or required fallback; acceptance failed",
  )
}
