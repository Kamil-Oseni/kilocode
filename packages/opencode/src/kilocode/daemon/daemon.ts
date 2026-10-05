import path from "path"
import { existsSync } from "fs"
import { spawn } from "child_process"
import { createServer } from "net"
import { randomUUID } from "node:crypto"
import { validateObservation } from "@opencode-ai/core/kilocode/profile-observation"
import { open, readFile, rm, mkdir } from "fs/promises"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { serverUrls } from "@/kilocode/cli/server-urls"
import { Certificate, canonical, image, roots, verify } from "./ownership"
import * as Windows from "@/kilocode/background-process/windows-tree"
import { watch as exit } from "./exit"

export namespace Daemon {
  const username = "kilo"
  const lock = "kilocode-daemon"
  export const PortRange = { start: 4097, end: 4116 } as const

  export const Network = z.object({
    hostname: z.string(),
    port: z.number().int().nonnegative(),
    mdns: z.boolean(),
    mdnsDomain: z.string(),
    cors: z.array(z.string()).transform((items) => [...new Set(items)].sort()),
  })
  export type Network = z.infer<typeof Network>
  export type NetworkOption = keyof Network

  export const State = z.object({
    pid: z.number().int().positive(),
    hostname: z.string(),
    port: z.number().int().positive(),
    url: z.string(),
    urls: z
      .object({
        local: z.string(),
        network: z.string().optional(),
        bind: z.string(),
      })
      .optional(),
    username: z.string(),
    password: z.string(),
    token: z.string(),
    version: z.string(),
    startedAt: z.string(),
    log: z.string(),
    options: Network.optional(),
    owner: Certificate.optional(),
    uncertain: z.string().optional(),
  })
  export type State = z.infer<typeof State>

  export const Status = z.object({
    running: z.boolean(),
    stale: z.boolean(),
    state: State.optional(),
    health: z
      .object({
        healthy: z.boolean(),
        version: z.string(),
      })
      .optional(),
    reason: z.string().optional(),
    file: z.string(),
  })
  export type Status = z.infer<typeof Status>

  export type Options = Network & {
    command?: string[]
    env?: NodeJS.ProcessEnv
    timeout?: number
  }

  export type Start = Status & {
    started: boolean
    reused: boolean
  }

  export type Ensure = {
    result: Start
    restarted: boolean
  }

  export type Stop = Status & {
    stopped: boolean
    retirement?: Awaited<ReturnType<typeof retire>>
  }

  export type Identity = Pick<State, "pid" | "startedAt">

  const pending = new Set<Promise<unknown>>()
  const failures: unknown[] = []
  let closing: Promise<void> | undefined
  const owners = new Map<string, State>()
  const retired = new Map<string, NonNullable<Awaited<ReturnType<typeof retire>>>>()
  let capture:
    | Promise<
        Readonly<{
          roots: readonly { kind: "json" | "sqlite"; path: string }[]
          receipts: readonly NonNullable<Awaited<ReturnType<typeof retire>>>[]
          completeProfileCoverage: false
          portableCaptureAuthorized: false
        }>
      >
    | undefined

  function accept<A>(body: () => Promise<A>): Promise<A> {
    if (closing) return Promise.reject(new Error("Daemon controller admission is closed"))
    const work = Promise.resolve().then(body)
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      (err) => {
        failures.push(err)
        pending.delete(work)
      },
    )
    return work
  }

  /** Fence synchronously, join accepted controllers; detached daemons are not silently stopped. */
  export function quiesce() {
    if (closing) return closing
    closing = Promise.allSettled([...pending]).then(() => {
      if (failures.length) throw new AggregateError(failures, "Daemon controller work could not be confirmed")
    })
    return closing
  }

  /** Explicit capture closure, separate from ordinary CLI exit or daemon attachment. */
  export function closeForCapture() {
    if (capture) return capture
    const joined = quiesce() // Synchronous fence precedes every asynchronous lock/read.
    capture = joined.then(() =>
      Flock.withLock(
        lock,
        async () => {
          const current = await read()
          if (current) {
            if (!current.owner || current.uncertain) throw new Error("Unconfirmed daemon participant prevents capture")
            owners.set(current.owner.generation, current)
          }
          for (const state of owners.values()) {
            if (!state.owner) throw new Error("Daemon participant has no ownership certificate")
            if (!retired.has(state.owner.generation)) await retire(state, true)
            if (retired.get(state.owner.generation)?.purpose !== "capture")
              throw new Error("Ordinary daemon retirement cannot certify persistent descendant closure")
          }
          if (current) await clear()
          const roots = new Map<string, { kind: "json" | "sqlite"; path: string }>()
          for (const state of owners.values())
            for (const [kind, file] of Object.entries(state.owner!.roots)) {
              if ((await canonical(file)) !== file) throw new Error("Daemon historical root identity changed")
              const root = { kind: kind === "database" ? ("sqlite" as const) : ("json" as const), path: file }
              roots.set(`${root.kind}:${root.path}`, Object.freeze(root))
            }
          for (const receipt of retired.values())
            for (const root of receipt.roots.roots) {
              const file = await canonical(root.path)
              roots.set(`${root.kind}:${file}`, Object.freeze({ kind: root.kind, path: file }))
            }
          return Object.freeze({
            roots: Object.freeze([...roots.values()].sort((a, b) => a.path.localeCompare(b.path))),
            receipts: Object.freeze([...retired.values()]),
            completeProfileCoverage: false as const,
            portableCaptureAuthorized: false as const,
          })
        },
        { dir: path.join(root(), "locks"), timeoutMs: 15000, staleMs: 30000 },
      ),
    )
    return capture
  }

  function root() {
    return process.env.KILO_TEST_DAEMON_STATE_DIR ?? Global.Path.state
  }

  function logs() {
    return process.env.KILO_TEST_DAEMON_LOG_DIR ?? Global.Path.log
  }

  export function file() {
    return path.join(root(), "daemon.json")
  }

  export function log() {
    return path.join(logs(), "daemon.log")
  }

  function auth(password: string) {
    return Buffer.from(`${username}:${password}`).toString("base64")
  }

  function host(input: string) {
    if (input === "0.0.0.0") return "127.0.0.1"
    return input
  }

  export async function read() {
    const data = await Filesystem.readJson(file()).catch((err) => {
      if (code(err) === "ENOENT") return undefined
      throw err
    })
    if (!data) return undefined
    return State.parse(data)
  }

  async function write(input: State) {
    await Filesystem.writeJson(file(), input, 0o600)
  }

  async function clear() {
    await rm(file(), { force: true })
  }

  function code(err: unknown) {
    if (!err || typeof err !== "object" || !("code" in err)) return undefined
    const value = err.code
    if (typeof value !== "string") return undefined
    return value
  }

  function alive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      if (code(err) === "EPERM") return true
      return false
    }
  }

  async function health(input: State) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 2_000)
    try {
      const res = await fetch(`${input.url}/global/health`, {
        signal: ctl.signal,
        headers: {
          authorization: `Basic ${input.token}`,
        },
      })
      if (!res.ok) return undefined
      return z.object({ healthy: z.boolean(), version: z.string() }).parse(await res.json())
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  export async function status(): Promise<Status> {
    const state = await read().catch((err) => {
      if (err instanceof z.ZodError || err instanceof SyntaxError) return undefined
      throw err
    })
    if (!state) return { running: false, stale: false, file: file(), reason: "not running" }
    if (!alive(state.pid)) return { running: false, stale: true, state, file: file(), reason: "process is not running" }
    if (!state.owner || state.uncertain)
      return {
        running: false,
        stale: true,
        state,
        file: file(),
        reason: "live process has no confirmed daemon ownership",
      }
    const owned = await verify(state.pid, state.owner).then(
      () => true,
      () => false,
    )
    if (!owned) return { running: false, stale: true, state, file: file(), reason: "process ownership mismatch" }
    const probe = await health(state)
    if (!probe) return { running: false, stale: true, state, file: file(), reason: "health check failed" }
    if (probe.version !== InstallationVersion) {
      return { running: false, stale: true, state, health: probe, file: file(), reason: "version mismatch" }
    }
    return { running: true, stale: false, state, health: probe, file: file() }
  }

  export function matches(state: State, input: Options, explicit: readonly NetworkOption[]) {
    if (state.password === "kilo") return false
    const options = Network.parse(input)
    return explicit.every((name) => {
      if (name === "hostname") return state.hostname === options.hostname
      if (name === "port") return options.port === 0 || state.port === options.port
      if (name === "mdns" && state.hostname !== options.hostname) return false
      if (!state.options) return false
      if (name === "cors") return state.options.cors.join("\n") === options.cors.join("\n")
      return state.options[name] === options[name]
    })
  }

  async function run(input: Options, explicit: readonly NetworkOption[] = [], force = false): Promise<Ensure> {
    return await accept(() =>
      Flock.withLock(
        lock,
        async () => {
          const current = await status()
          if (current.state?.uncertain)
            throw new Error("Daemon retirement uncertainty is retained; controller state preserved")
          const expected = await roots({ ...process.env, ...input.env }, root(), log())
          if (current.state?.owner && JSON.stringify(current.state.owner.roots) !== JSON.stringify(expected))
            throw new Error("Daemon profile roots differ; existing process preserved")
          const restarted = current.running && !!current.state && (force || !matches(current.state, input, explicit))
          if (current.running && !restarted) {
            if (current.state?.owner) owners.set(current.state.owner.generation, current.state)
            return { result: { ...current, started: false, reused: true }, restarted: false }
          }
          if (current.state && (current.stale || restarted)) {
            await retire(current.state)
          }
          await clear()
          const password = randomUUID()
          const token = auth(password)
          const out = log()
          await mkdir(path.dirname(out), { recursive: true })
          await Filesystem.write(out, "", 0o600)
          const ready = await launch({ ...input, port: await port(input) }, password, out)
          const state = {
            pid: ready.pid,
            hostname: ready.hostname,
            port: ready.port,
            url: `http://${host(ready.hostname)}:${ready.port}`,
            urls: serverUrls(ready.hostname, ready.port),
            username,
            password,
            token,
            version: InstallationVersion,
            startedAt: new Date().toISOString(),
            log: out,
            options: Network.parse(input),
            owner: ready.owner,
          }
          await write(state)
          owners.set(state.owner.generation, state)
          const next = await status()
          return { result: { ...next, started: true, reused: false, state }, restarted }
        },
        { dir: path.join(root(), "locks"), timeoutMs: 15_000, staleMs: 30_000 },
      ),
    )
  }

  export async function start(input: Options): Promise<Start> {
    return (await run(input)).result
  }

  export async function ensure(input: Options, explicit: readonly NetworkOption[]): Promise<Ensure> {
    return await run(input, explicit)
  }

  export async function stop(expected?: Identity): Promise<Stop> {
    return await accept(() =>
      Flock.withLock(
        lock,
        async () => {
          const current = await status()
          if (!current.state || (expected && !same(current.state, expected))) return { ...current, stopped: false }
          if (current.state.uncertain)
            throw new Error("Daemon retirement uncertainty is retained; controller state preserved")
          const retirement = await retire(current.state)
          await clear()
          return { ...current, running: false, stale: false, stopped: true, retirement }
        },
        { dir: path.join(root(), "locks"), timeoutMs: 15_000, staleMs: 30_000 },
      ),
    )
  }

  export async function foreground(start: (signal: AbortSignal) => Promise<Identity>) {
    const ctl = new AbortController()
    const interrupt = new AbortController()
    const done = Promise.withResolvers<"signal">()
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
    const quit = () => {
      interrupt.abort()
      done.resolve("signal")
    }
    for (const signal of signals) process.once(signal, quit)

    try {
      const expected = await start(interrupt.signal)
      if (interrupt.signal.aborted) {
        await stop(expected)
        return
      }
      const result = await Promise.race([done.promise, watch(expected, ctl.signal)])
      if (result === "signal") await stop(expected)
    } finally {
      ctl.abort()
      for (const signal of signals) process.off(signal, quit)
    }
  }

  export async function restart(input: Options): Promise<Start> {
    return (await run(input, [], true)).result
  }

  export function command(
    input?: string[],
    proc = { argv: process.argv, execArgv: process.execArgv, execPath: process.execPath },
  ) {
    if (input?.length) return input
    const script = proc.argv[1]
    const bundled = script?.startsWith("/$bunfs/") || (script ? /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script) : false)
    if (script && !bundled && /\.(ts|js|mjs|cjs)$/.test(script)) return [proc.execPath, ...clean(proc.execArgv), script]
    return [proc.execPath]
  }

  export function clean(input: string[]) {
    return input.filter((arg, index) => {
      if (arg === "--cwd") return false
      if (input[index - 1] === "--cwd") return false
      if (arg.startsWith("--cwd=")) return false
      return true
    })
  }

  function args(input: Options) {
    return [
      "serve",
      "--hostname",
      input.hostname,
      "--port",
      String(input.port),
      ...(input.mdns ? ["--mdns"] : []),
      ...(input.mdnsDomain ? ["--mdns-domain", input.mdnsDomain] : []),
      ...(input.cors ?? []).flatMap((item) => ["--cors", item]),
    ]
  }

  async function port(input: Options) {
    if (input.port !== 0) return input.port
    if (input.env?.KILO_TEST_DAEMON_EPHEMERAL_PORT) return 0
    const ports = Array.from({ length: PortRange.end - PortRange.start + 1 }, (_, index) => PortRange.start + index)
    const free = await Promise.any(
      ports.map((item) =>
        available(input.hostname, item).then((value) => {
          if (value) return item
          throw new Error(`port ${item} unavailable`)
        }),
      ),
    ).catch(() => undefined)
    if (!free) throw new Error(`No available daemon ports in ${PortRange.start}-${PortRange.end}`)
    return free
  }

  async function available(hostname: string, port: number) {
    return await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once("error", () => resolve(false))
      server.listen(port, hostname, () => server.close(() => resolve(true)))
    })
  }

  async function launch(input: Options, password: string, out: string) {
    const cmd = command(input.command)
    const env = { ...process.env, ...input.env }
    const inventory = await roots(env, root(), out)
    const generation = randomUUID()
    const request = path.join(root(), `daemon-${generation}.request.json`)
    const receipt = path.join(root(), `daemon-${generation}.receipt.json`)
    const stdout = await open(out, "a")
    const stderr = await open(out, "a")
    try {
      const child = spawn(cmd[0], [...cmd.slice(1), ...args(input)], {
        cwd: cwd(cmd),
        detached: true,
        env: {
          ...env,
          RAYA_SERVER_USERNAME: username,
          KILO_SERVER_USERNAME: username,
          RAYA_SERVER_PASSWORD: password,
          KILO_SERVER_PASSWORD: password,
          KILOCODE_FEATURE: "daemon",
          RAYA_DAEMON_GENERATION: generation,
          RAYA_DAEMON_REQUEST: request,
          RAYA_DAEMON_RECEIPT: receipt,
        },
        stdio: ["ignore", stdout.fd, stderr.fd],
        windowsHide: process.platform === "win32",
      })
      const failure = new Promise<never>((_, reject) => child.once("error", reject))
      child.unref()
      await Filesystem.writeJson(
        path.join(root(), `daemon-${generation}.pending.json`),
        {
          version: 1,
          generation,
          pid: child.pid,
          roots: inventory,
          request,
          receipt,
          phase: "spawned-unconfirmed",
          portableCaptureAuthorized: false,
        },
        0o600,
      )
      const owner = child.pid
        ? { version: 1 as const, generation, ...(await image(child.pid)), roots: inventory, request, receipt }
        : undefined
      if (!owner) throw new Error("Daemon process did not provide an ownership certificate")
      return await Promise.race([wait(out, child.pid, input.timeout ?? 10_000), failure])
        .then((ready) => ({ ...ready, owner }))
        .catch(async (err) => {
          if (child.pid && alive(child.pid)) {
            await verify(child.pid, owner)
            const result = await Windows.terminate(child.pid, owner.birth)
            throw new AggregateError(
              [
                err,
                new Error(`Daemon startup required forced termination (${result}); clean retirement is unconfirmed`),
              ],
              "Daemon startup outcome is uncertain",
            )
          }
          throw err
        })
    } finally {
      await Promise.all([stdout.close(), stderr.close()])
    }
  }

  function cwd(cmd: string[]) {
    const script = cmd.find((arg) => /\.(ts|js|mjs|cjs)$/.test(arg))
    if (!script) return Global.Path.home
    return packageRoot(path.dirname(script)) ?? Global.Path.home
  }

  function packageRoot(dir: string): string | undefined {
    if (existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    return packageRoot(parent)
  }

  async function wait(out: string, pid: number | undefined, timeout: number) {
    if (!pid) throw new Error("Daemon process did not provide a pid")
    const started = Date.now()
    while (true) {
      const match = await line(out)
      if (match) return { pid, hostname: match.hostname, port: match.port }
      if (!alive(pid)) throw new Error(`Daemon exited before listening. Log: ${out}`)
      if (Date.now() - started > timeout) throw new Error(`Timed out waiting for daemon. Log: ${out}`)
      await sleep(100)
    }
  }

  async function line(out: string) {
    const text = await readFile(out, "utf8").catch((err) => {
      if (code(err) === "ENOENT") return ""
      throw err
    })
    const match = text.match(/kilo server listening on http:\/\/([^:\s]+):(\d+)/)
    if (!match) return undefined
    return { hostname: match[1], port: Number(match[2]) }
  }

  function same(state: State, expected: Identity) {
    return state.pid === expected.pid && state.startedAt === expected.startedAt
  }

  async function watch(expected: Identity, signal: AbortSignal): Promise<"daemon"> {
    while (!signal.aborted) {
      const state = await read()
      if (!state || !same(state, expected) || !alive(expected.pid)) return "daemon"
      await sleep(250, signal)
    }
    return "daemon"
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", cancel)
        resolve()
      }
      const timer = setTimeout(done, ms)
      const cancel = () => {
        clearTimeout(timer)
        done()
      }
      if (signal?.aborted) {
        cancel()
        return
      }
      signal?.addEventListener("abort", cancel, { once: true })
    })
  }

  async function retire(state: State, capture = false) {
    if (!alive(state.pid)) throw new Error("Daemon exit occurred without a held exit observation; state preserved")
    if (!state.owner || state.uncertain)
      throw new Error("Unconfirmed live daemon preserved; exact ownership is required")
    await verify(state.pid, state.owner)
    const owner = state.owner
    const request = randomUUID()
    const observer = await exit(state.pid, owner.birth, 30_000)
    try {
      await Filesystem.writeJson(
        owner.request,
        { version: 1, generation: owner.generation, request, ...(capture ? { purpose: "capture" as const } : {}) },
        0o600,
      )
      const exited = await observer.done
      if (exited.code !== 0) throw new Error(`Daemon exited with code ${exited.code}; retirement remains uncertain`)
      const receipt = z
        .object({
          version: z.literal(1),
          generation: z.literal(owner.generation),
          request: z.literal(request),
          purpose: capture ? z.literal("capture") : z.undefined().optional(),
          pid: z.literal(state.pid),
          birth: z.literal(owner.birth),
          executable: z.literal(owner.executable),
          digest: z.literal(owner.digest),
          success: z.literal(true),
          roots: z.unknown(),
          portableCaptureAuthorized: z.literal(false),
        })
        .strict()
        .parse(await Filesystem.readJson(owner.receipt))
      const selected = await validateObservation(receipt.roots)
      const value = Object.freeze({
        ...receipt,
        roots: selected,
        exit: Object.freeze(exited),
        forced: false as const,
      })
      retired.set(owner.generation, value)
      return value
    } catch (err) {
      await write({ ...state, uncertain: "Cooperative daemon retirement was not confirmed" })
      throw err
    } finally {
      await observer.close()
    }
  }
}
