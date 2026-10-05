import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { text as streamText } from "node:stream/consumers"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@kilocode/sdk/v2"
import type { EventSource } from "@opencode-ai/tui/context/sdk"
import { HeapSnapshot } from "@/kilocode/cli/heap-snapshot" // kilocode_change - admitted diagnostics writer
import type { StartInput } from "@/kilocode/cli/cmd/tui/thread" // kilocode_change - runtime imports deferred into handlers
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"
import { validateSession } from "../tui/validate-session"
// kilocode_change start - correlate the TUI worker with its parent process
import {
  KILO_PROCESS_ROLE,
  KILO_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@opencode-ai/core/util/opencode-process"
// kilocode_change end
import type { RemoteExitBridgeClient } from "@/kilocode/cli/cmd/tui/remote-exit-bridge" // kilocode_change - runtime import deferred
import type { Exit } from "@opencode-ai/tui/context/exit" // kilocode_change
import { parentStop } from "@/kilocode/cli/cmd/tui/parent-stop" // kilocode_change
import * as WorkerIdentity from "@/kilocode/cli/cmd/tui/worker-identity" // kilocode_change
import { parentLifecycle } from "@/kilocode/cli/cmd/tui/parent-lifecycle" // kilocode_change

declare global {
  const KILO_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

// kilocode_change start - bridge remote exit only for the embedded worker transport
export function embeddedRemoteExitClient<T>(external: boolean, client: T | undefined): T | undefined {
  return external ? undefined : client
}

export async function runEmbeddedRemoteExitBridge(input: {
  client: RemoteExitBridgeClient
  exit: Exit
  done: Promise<unknown>
  timeoutMs?: number
}) {
  const { createParentRemoteExitBridge } = await import("@/kilocode/cli/cmd/tui/remote-exit-bridge")
  const timeoutMs = input.timeoutMs ?? 5_000
  const bridge = createParentRemoteExitBridge(input.client, input.exit)
  const failures: unknown[] = []
  try {
    await withTimeout(bridge.ready(), timeoutMs, "remote exit startup timed out").catch((err) => failures.push(err))
    await input.done.catch((err) => failures.push(err))
  } finally {
    await bridge.dispose(timeoutMs).catch((err) => failures.push(err))
  }
  if (failures.length) throw new AggregateError(failures, "TUI remote exit retirement failed", { cause: failures[0] })
}
// kilocode_change end

// kilocode_change start - share the extracted TUI runner between daemon and worker paths
async function start(input: StartInput, remoteExitClient?: RpcClient, publish?: (exit: Exit) => void) {
  const { Effect } = await import("effect")
  const { run } = await import("../tui/layer")
  const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
  const pluginHost = createLegacyTuiPluginHost()
  if (!remoteExitClient) {
    await Effect.runPromise(run({ ...input, pluginHost, onExit: publish ?? input.onExit }))
    return
  }

  const ready = Promise.withResolvers<Exit>()
  const done = Effect.runPromise(
    run({
      ...input,
      pluginHost,
      onExit: (exit) => {
        ready.resolve(exit)
        publish?.(exit)
      },
    }),
  )
  const exit = await Promise.race([ready.promise, done.then(() => undefined)])
  if (!exit) return
  await runEmbeddedRemoteExitBridge({ client: remoteExitClient, exit, done })
}
// kilocode_change end

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof KILO_WORKER_PATH !== "undefined") return KILO_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await streamText(process.stdin)
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  // kilocode_change start - ignore stale PWD from wrappers such as `bun --cwd`, except kilo-dev's caller cwd
  const dev = process.env.KILO_DEV_CWD
  const real = Filesystem.resolve(cwd)
  const root = dev
    ? Filesystem.resolve(dev)
    : envPWD && Filesystem.resolve(envPWD) === real
      ? Filesystem.resolve(envPWD)
      : real
  // kilocode_change end
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return dev ? root : real // kilocode_change
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start kilo tui", // kilocode_change
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start kilo in", // kilocode_change
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("cloud-fork", {
        type: "boolean",
        describe: "fetch session from cloud and continue locally (use with --session)",
      })
      // kilocode_change start - create/reuse a git worktree before starting
      .option("worktree", {
        type: "string",
        describe: "create (or reuse) a git worktree with this name and start kilo there",
      })
      // kilocode_change end
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    // kilocode_change start - lazy Kilo implementations so other CLI commands
    // don't pay their module cost at startup
    const { importCloudSession, localSessionID, validateCloudFork, reportCloudImportError } = await import(
      "@/kilocode/cloud-session"
    )
    const { KiloTuiThreadDaemon } = await import("@/kilocode/cli/cmd/tui/thread")
    const { preload } = await import("@/kilocode/cli/cmd/tui")
    const { resolveTuiDirectory } = await import("@/kilocode/cli/cmd/tui-worktree")
    // kilocode_change end
    const unguard = win32InstallCtrlCGuard()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }
      // kilocode_change start
      const cloudForkError = validateCloudFork(args)
      if (cloudForkError) {
        UI.error(cloudForkError)
        process.exitCode = 1
        return
      }
      // kilocode_change end

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      // kilocode_change start - `--worktree <name>` creates/reuses a worktree; resuming
      // an explicit `--session <id>` tries to restart in that session's worktree
      const next = await resolveTuiDirectory(args, resolveThreadDirectory(args.project)).catch((error) => {
        UI.error(errorMessage(error))
        process.exitCode = 1
      })
      if (!next) return
      // kilocode_change end
      const file = await target()
      // kilocode_change start
      const preloads = preload(typeof KILO_WORKER_PATH !== "undefined", () =>
        import.meta.resolve("@opentui/solid/preload"),
      )
      // kilocode_change end
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())
      // kilocode_change start - retire the attached renderer without stopping its independently owned daemon
      const attached = parentLifecycle({
        stop: async () => undefined,
        interrupt: () => {
          if (!process.stdin.isTTY) process.stdin.destroy()
        },
      })
      const handled = await attached.use(async () => {
        const handled = await KiloTuiThreadDaemon.attach({
          args,
          cwd,
          input: () =>
            input(args.prompt).catch((err) => {
              if (attached.requested()) return undefined
              throw err
            }),
          start: (input) => attached.render((publish) => start(input, undefined, publish)),
        })
        return handled || attached.requested()
      })
      if (handled) return
      // kilocode_change end
      const auth = KiloTuiThreadDaemon.workerAuth() // kilocode_change - protect TUI-owned HTTP routes from unauthenticated local callers
      // kilocode_change start - propagate stable run metadata and an explicit worker role
      const env = sanitizedProcessEnv({
        [WorkerIdentity.GENERATION]: crypto.randomUUID(),
        [KILO_PROCESS_ROLE]: "worker",
        [KILO_RUN_ID]: ensureRunID(),
        ...auth.env,
        KILO_BACKGROUND_PROCESS_PORTS: "true",
      })
      // kilocode_change end
      const worker = new Worker(file, {
        preload: preloads, // kilocode_change
        env, // kilocode_change
      })
      worker.onerror = (e) => {
        console.error("TUI worker error", e.error ?? e.message)
      }
      const client = Rpc.client<typeof rpc>(worker)
      const reload = () => {
        client.call("reload", undefined).catch((err) => console.error("TUI worker reload failed", err))
      }
      process.on("SIGUSR2", reload)

      // kilocode_change start - join repeated exits and retain any unconfirmed forced shutdown
      const request = WorkerIdentity.request(WorkerIdentity.identity(env))
      const stop = parentStop({
        worker,
        request,
        shutdown: () => client.call("shutdown", request),
        detach: () => process.off("SIGUSR2", reload),
      })
      // kilocode_change end
      // kilocode_change start - own signals and join the renderer scope before worker retirement
      const lifecycle = parentLifecycle({
        stop,
        interrupt: () => {
          if (!process.stdin.isTTY) process.stdin.destroy()
        },
      })
      lifecycle.defer(() => process.off("SIGUSR2", reload))
      await lifecycle.use(async () => {
        // kilocode_change end

        // kilocode_change start - signal interruption of owned piped input returns through retirement
        const prompt = await input(args.prompt).catch((err) => {
          if (lifecycle.requested()) return undefined
          throw err
        })
        // kilocode_change end
        if (lifecycle.requested()) return // kilocode_change
        const config = await TuiConfig.get()
        if (lifecycle.requested()) return // kilocode_change

        const network = resolveNetworkOptionsNoConfig(args)
        const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true

        const transport = external
          ? {
              url: (await client.call("server", network)).url,
              fetch: undefined,
              headers: auth.headers, // kilocode_change
              events: undefined,
            }
          : {
              url: "http://kilo.internal",
              fetch: createWorkerFetch(client),
              headers: auth.headers, // kilocode_change
              events: createEventSource(client),
            }

        if (lifecycle.requested()) return // kilocode_change
        // kilocode_change - upstream validates here, but --cloud-fork's session id is only local after
        // the import below; the guarded validateSession further down covers both paths.
        const upgrade = setTimeout(() => {
          // kilocode_change
          client.call("checkUpgrade", { directory: cwd }).catch((err) => console.error("Upgrade check failed", err))
        }, 1000) // kilocode_change
        upgrade.unref?.() // kilocode_change
        lifecycle.defer(() => clearTimeout(upgrade)) // kilocode_change

        // kilocode_change start - import cloud session before TUI renders
        if (args.cloudFork && args.session) {
          UI.println("Importing session from cloud...")
          const { createKiloClient } = await import("@kilocode/sdk/v2")
          const sdk = createKiloClient({
            baseUrl: transport.url,
            fetch: transport.fetch,
            headers: transport.headers, // kilocode_change
            directory: cwd,
          })
          try {
            const id = await importCloudSession(sdk, args.session)
            args.session = id
            args.cloudFork = false
          } catch (err) {
            reportCloudImportError(err)
            process.exitCode = 1
            return
          }
        }
        // kilocode_change end

        if (lifecycle.requested()) return // kilocode_change
        try {
          await validateSession({
            url: transport.url, // kilocode_change
            sessionID: localSessionID(args), // kilocode_change
            directory: cwd,
            fetch: transport.fetch,
            headers: transport.headers, // kilocode_change
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

        // kilocode_change start
        await lifecycle.render((publish) =>
          start(
            {
              // kilocode_change - shared lazy loader also supports daemon attach
              url: transport.url,
              async onSnapshot() {
                const tui = await HeapSnapshot.write({ role: "tui" })
                const server = await client.call("snapshot", undefined)
                return [tui, server]
              },
              config,
              directory: cwd,
              fetch: transport.fetch,
              headers: transport.headers,
              events: transport.events,
              args: {
                continue: args.continue,
                sessionID: args.session,
                agent: args.agent,
                model: args.model,
                prompt,
                fork: args.fork,
                auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
              },
            },
            embeddedRemoteExitClient(external, client),
            publish,
          ),
        )
        // kilocode_change end
      }) // kilocode_change
    } finally {
      try {
        unguard?.()
      } catch (err) {
        console.error("Failed to remove Windows Ctrl+C guard", err)
      }
    }
    return // kilocode_change - preserve exitCode and retire parent owners through index.ts finally
  },
})
