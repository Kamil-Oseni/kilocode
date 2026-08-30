import { RecallTool } from "../../tool/recall"
import { AgentManagerModelsTool } from "./agent-manager-models"
import { AgentManagerTool } from "./agent-manager"
import { BackgroundProcessTool } from "./background-process"
import { ChartTool } from "./chart"
import { GenerateImageTool } from "./generate-image"
import { InteractiveTerminalTool } from "./interactive-terminal"
import { NotebookEditTool, NotebookExecuteTool, NotebookReadTool } from "./notebook-host"
import { MemoryRecallTool } from "./memory-recall"
import { MemorySaveTool } from "./memory-save"
import { NotifyUserTool } from "./notify-user"
import { SendFileTool } from "./send-file"
import * as Tool from "../../tool/tool"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import { Notebook } from "@/kilocode/notebook/service"
import { AgentManager, HostError } from "@/kilocode/agent-manager/service"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import * as Log from "@opencode-ai/core/util/log"
import type { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { KiloMemory } from "@kilocode/kilo-memory/effect"
import { MemoryPaths } from "@kilocode/kilo-memory/effect/paths"
import type { Storage } from "@/storage/storage" // raya_change - Milestone A goal tool dependencies
import type { Session } from "@/session/session" // raya_change - Milestone A goal audit evidence
import { RayaGoal } from "@/kilocode/goal" // raya_change - Milestone A goal state
import { RayaSelfHeal } from "@/kilocode/self-heal" // raya_change - hybrid self-heal classification refinement
import { goalTools } from "./goal" // raya_change - Milestone A model-facing tools
import { selfHealTools } from "./self-heal" // raya_change - repair agent reconciles its own classification
import { ChiefRouteTool } from "./chief-route" // raya_change - Milestone B intelligent auto-routing
import { AskOptionsTool } from "./ask-options" // raya_change - Milestone C selectable options
import { BrowserTools } from "./browser-host" // raya_change - Milestone F browser tools
import { Browser } from "@/kilocode/browser/service" // raya_change - Milestone F browser bridge
import { CanvasTools } from "./canvas-host" // raya_change - Milestone E canvas tools
import { Canvas } from "@/kilocode/canvas/service" // raya_change - Milestone E canvas bridge

const log = Log.create({ service: "kilocode-tool-registry" })
type Deps = { agent: Agent.Interface; truncate: Truncate.Interface; indexing?: boolean }
type Loaders = {
  indexing?: () => Promise<{ KiloIndexing: { ready: () => boolean } }>
  semantic?: () => Promise<Pick<typeof import("@/kilocode/tool/semantic-search"), "SemanticSearchTool">>
}

export namespace KiloToolRegistry {
  const hint =
    "- When you are doing an open-ended search where you do not know the exact symbol name, use the `semantic_search` tool first to narrow down the search scope, then follow up with `Grep` and/or `Read`"

  export function indexing(
    config: Pick<Config.Info, "indexing">,
    global?: Pick<Config.Info, "indexing">,
  ): boolean | undefined {
    return config.indexing?.enabled ?? global?.indexing?.enabled
  }

  export function usePatch(input: { modelID: string; family?: string }) {
    if (process.env["KILO_E2E_LLM_URL"]) return true

    const id = input.modelID.toLowerCase()
    const family = input.family?.toLowerCase()
    if (id.includes("gpt-4") || family?.startsWith("gpt-4")) return false
    if (id.includes("oss") || family?.includes("oss") || family === "gpt-image") return false
    if (id.includes("gpt-")) return true
    return family?.startsWith("gpt") ?? false
  }

  /** Resolve Kilo-specific tool Infos outside any InstanceState, so their Truncate/Agent deps are
   * satisfied at the outer registry scope instead of leaking into InstanceState's Effect. */
  const unavailable = AgentManager.Service.of({
    request: () =>
      Effect.fail(
        new HostError({ code: "disconnected", detail: "Agent Manager orchestration is unavailable in this runtime" }),
      ),
    list: () => Effect.succeed([]),
    reply: () => Effect.die(new Error("Agent Manager orchestration is unavailable in this runtime")),
    reject: () => Effect.die(new Error("Agent Manager orchestration is unavailable in this runtime")),
  })

  export function infos(
    host?: AgentManager.Interface,
    notebook?: Notebook.Interface,
    goalDeps?: { storage: Storage.Interface; sessions: Session.Interface }, // raya_change - Milestone A
    browser?: Browser.Interface, // raya_change - Milestone F browser bridge
    canvas?: Canvas.Interface, // raya_change - Milestone E canvas bridge
  ) {
    return Effect.gen(function* () {
      const recall = yield* RecallTool
      const managerModels = yield* AgentManagerModelsTool
      const memory = yield* MemoryRecallTool
      const save = yield* MemorySaveTool
      const manager = yield* AgentManagerTool.pipe(Effect.provideService(AgentManager.Service, host ?? unavailable))
      const process = yield* BackgroundProcessTool
      const chart = yield* ChartTool
      const image = yield* GenerateImageTool
      const terminal = yield* InteractiveTerminalTool
      // The notify_user tool depends on KiloSessions.Service, which the tool-registry layer provides
      // via KiloSessions.defaultLayer (see src/tool/registry.ts). Grabs the service from the surrounding
      // context here and injects it into the tool's init Effect.
      const sessions = yield* KiloSessions.Service
      const notify = yield* NotifyUserTool.pipe(Effect.provideService(KiloSessions.Service, sessions))
      const send = yield* SendFileTool
      const chief = yield* ChiefRouteTool // raya_change - Milestone B intelligent auto-routing
      const ask = yield* AskOptionsTool // raya_change - Milestone C selectable options
      // raya_change start - Milestone F browser tools
      const browserTools = browser
        ? yield* Effect.all(BrowserTools).pipe(Effect.provideService(Browser.Service, browser))
        : undefined
      // raya_change end
      // raya_change start - Milestone E canvas tools
      const canvasTools = canvas
        ? yield* Effect.all(CanvasTools).pipe(Effect.provideService(Canvas.Service, canvas))
        : undefined
      // raya_change end
      // raya_change start - Milestone A model-facing goal tools
      const goalState = goalDeps ? RayaGoal.make(goalDeps) : undefined
      const goals = goalState && goalDeps ? goalTools(goalState, goalDeps.sessions) : undefined
      const goalCreate = goals ? yield* goals.create : undefined
      const goalGet = goals ? yield* goals.get : undefined
      const goalUpdate = goals ? yield* goals.update : undefined
      // raya_change - hybrid self-heal: the repair agent reconciles its own item's classification
      const heal = goalState && goalDeps ? selfHealTools(goalState, RayaSelfHeal.make(goalDeps.storage)) : undefined
      const healRefine = heal ? yield* heal.refine : undefined
      const goal = { goalCreate, goalGet, goalUpdate, healRefine }
      // raya_change end
      if (!notebook)
        return {
          recall,
          managerModels,
          memory,
          save,
          manager,
          process,
          chart,
          image,
          terminal,
          notify,
          send,
          chief,
          ask,
          browser: browserTools, // raya_change - Milestone F browser tools
          canvas: canvasTools, // raya_change - Milestone E canvas tools
          ...goal,
        }
      const tools = yield* Effect.all({
        notebookRead: NotebookReadTool,
        notebookEdit: NotebookEditTool,
        notebookExecute: NotebookExecuteTool,
      }).pipe(Effect.provideService(Notebook.Service, notebook))
      return {
        recall,
        managerModels,
        memory,
        save,
        manager,
        process,
        chart,
        image,
        terminal,
        notify,
        send,
        chief,
        ask,
        browser: browserTools, // raya_change - Milestone F browser tools
        canvas: canvasTools, // raya_change - Milestone E canvas tools
        ...goal,
        ...tools,
      }
    })
  }

  /** Finalize Kilo-specific tools into Tool.Defs. Call this inside the InstanceState state Effect —
   * it has no Service deps beyond what Tool.init itself needs. */
  export function build(
    tools: {
      recall: Tool.Info
      managerModels: Tool.Info
      memory: Tool.Info
      save: Tool.Info
      manager: Tool.Info
      process: Tool.Info
      chart: Tool.Info
      image: Tool.Info
      terminal?: Tool.Info
      notify: Tool.Info
      send: Tool.Info
      notebookRead?: Tool.Info
      notebookEdit?: Tool.Info
      notebookExecute?: Tool.Info
      goalCreate?: Tool.Info // raya_change - Milestone A
      goalGet?: Tool.Info // raya_change - Milestone A
      goalUpdate?: Tool.Info // raya_change - Milestone A
      healRefine?: Tool.Info // raya_change - hybrid self-heal classification
      chief?: Tool.Info // raya_change - Milestone B
      ask?: Tool.Info // raya_change - Milestone C
      browser?: Tool.Info[] // raya_change - Milestone F
      canvas?: Tool.Info[] // raya_change - Milestone E
    },
    deps: Deps,
    loaders: Loaders = {},
  ) {
    return Effect.gen(function* () {
      const base = yield* Effect.all({
        recall: Tool.init(tools.recall),
        managerModels: Tool.init(tools.managerModels),
        memory: Tool.init(tools.memory),
        save: Tool.init(tools.save),
        manager: Tool.init(tools.manager),
        process: Tool.init(tools.process),
        chart: Tool.init(tools.chart),
        image: Tool.init(tools.image),
        notify: Tool.init(tools.notify),
        send: Tool.init(tools.send),
      })
      const chief = tools.chief ? yield* Tool.init(tools.chief) : undefined // raya_change - Milestone B
      const ask = tools.ask ? yield* Tool.init(tools.ask) : undefined // raya_change - Milestone C
      const healRefine = tools.healRefine ? yield* Tool.init(tools.healRefine) : undefined // raya_change - hybrid self-heal
      const browser = tools.browser ? yield* Effect.all(tools.browser.map(Tool.init)) : [] // raya_change - Milestone F
      const canvas = tools.canvas ? yield* Effect.all(tools.canvas.map(Tool.init)) : [] // raya_change - Milestone E
      const terminal = tools.terminal ? yield* Tool.init(tools.terminal) : undefined
      const notebooks =
        tools.notebookRead && tools.notebookEdit && tools.notebookExecute
          ? yield* Effect.all({
              notebookRead: Tool.init(tools.notebookRead),
              notebookEdit: Tool.init(tools.notebookEdit),
              notebookExecute: Tool.init(tools.notebookExecute),
            })
          : {}
      const semantic = yield* semanticTool(deps, loaders)
      // raya_change start - Milestone A model-facing goal tools
      const goals =
        tools.goalCreate && tools.goalGet && tools.goalUpdate
          ? yield* Effect.all({
              goalCreate: Tool.init(tools.goalCreate),
              goalGet: Tool.init(tools.goalGet),
              goalUpdate: Tool.init(tools.goalUpdate),
            })
          : {}
      // raya_change end
      return {
        ...base,
        terminal,
        ...notebooks,
        ...goals,
        healRefine, // raya_change - hybrid self-heal classification
        semantic,
        notify: base.notify,
        send: base.send,
        chief,
        ask,
        browser, // raya_change - Milestone F
        canvas, // raya_change - Milestone E
      }
    })
  }

  function semanticTool(deps: Deps, loaders: Loaders) {
    return Effect.gen(function* () {
      const ready = yield* deps.indexing === undefined
        ? (() => {
            const indexing = loaders.indexing ?? (() => import("@/kilocode/indexing"))
            return Effect.tryPromise(() => indexing().then((mod) => mod.KiloIndexing.ready())).pipe(
              Effect.catch((err) =>
                Effect.sync(() => {
                  log.warn("semantic search unavailable", { err })
                  return false
                }),
              ),
            )
          })()
        : Effect.succeed(deps.indexing)
      if (!ready) return undefined

      const semantic = loaders.semantic ?? (() => import("@/kilocode/tool/semantic-search"))
      const mod = yield* Effect.tryPromise(() => semantic()).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            log.warn("semantic search tool unavailable", { err })
            return undefined
          }),
        ),
      )
      if (!mod) return undefined

      const info = yield* mod.SemanticSearchTool.pipe(
        Effect.provideService(Agent.Service, deps.agent),
        Effect.provideService(Truncate.Service, deps.truncate),
      )
      if (!info) return undefined
      return yield* Tool.init(info)
    })
  }

  /** Hide human-driven tools from agents that cannot interact with the user directly. */
  export function available(tool: Tool.Def, agent: Agent.Info) {
    if (tool.id === "chief_route") return agent.name === "auto" // raya_change - Milestone B
    if (tool.id === "ask_options") return agent.mode === "primary" // raya_change - Milestone C
    if (tool.id === "refine_self_heal") return agent.mode === "primary" // raya_change - hybrid self-heal reconcile
    if (tool.id === "notify_user") return KiloSessions.remoteStatus().enabled
    if (tool.id === "send_file") return KiloSessions.remoteStatus().connected
    if (tool.id !== "interactive_terminal") return true
    return agent.mode === "primary"
  }

  /** Kilo-specific tools to append to the builtin list */
  export function extra(
    tools: {
      semantic?: Tool.Def
      recall: Tool.Def
      managerModels: Tool.Def
      memory: Tool.Def
      save: Tool.Def
      manager: Tool.Def
      process: Tool.Def
      chart: Tool.Def
      image: Tool.Def
      terminal?: Tool.Def
      notify: Tool.Def
      send: Tool.Def
      notebookRead?: Tool.Def
      notebookEdit?: Tool.Def
      notebookExecute?: Tool.Def
      goalCreate?: Tool.Def // raya_change - Milestone A
      goalGet?: Tool.Def // raya_change - Milestone A
      goalUpdate?: Tool.Def // raya_change - Milestone A
      healRefine?: Tool.Def // raya_change - hybrid self-heal classification
      chief?: Tool.Def // raya_change - Milestone B
      ask?: Tool.Def // raya_change - Milestone C
      browser?: Tool.Def[] // raya_change - Milestone F
      canvas?: Tool.Def[] // raya_change - Milestone E
    },
    cfg: { experimental?: { image_generation?: boolean; native_notebook_tools?: boolean } },
  ): Tool.Def[] {
    return [
      ...(cfg.experimental?.image_generation === true ? [tools.image] : []),
      ...(tools.semantic ? [tools.semantic] : []),
      tools.memory,
      tools.save,
      tools.recall,
      ...(Flag.KILO_CLIENT === "vscode" ? [tools.chart] : []),
      ...(Flag.KILO_CLIENT === "cli" || Flag.KILO_CLIENT === "vscode" ? [tools.process] : []),
      ...(Flag.KILO_CLIENT === "cli" && tools.terminal ? [tools.terminal] : []),
      ...(Flag.KILO_CLIENT === "vscode" ? [tools.managerModels, tools.manager] : []),
      ...(Flag.KILO_CLIENT === "vscode" &&
      cfg.experimental?.native_notebook_tools === true &&
      tools.notebookRead &&
      tools.notebookEdit &&
      tools.notebookExecute
        ? [tools.notebookRead, tools.notebookEdit, tools.notebookExecute]
        : []),
      // raya_change - Milestone A goal tools are available in every client
      ...(tools.goalCreate && tools.goalGet && tools.goalUpdate
        ? [tools.goalCreate, tools.goalGet, tools.goalUpdate]
        : []),
      ...(tools.healRefine ? [tools.healRefine] : []), // raya_change - hybrid self-heal classification
      ...(tools.chief ? [tools.chief] : []), // raya_change - Milestone B
      ...(tools.ask ? [tools.ask] : []), // raya_change - Milestone C
      ...(Flag.KILO_CLIENT === "vscode" ? (tools.browser ?? []) : []), // raya_change - Milestone F
      ...(Flag.KILO_CLIENT === "vscode" ? (tools.canvas ?? []) : []), // raya_change - Milestone E
      tools.notify,
      tools.send,
    ]
  }

  // Re-keyed to root string so invalidate() works across ctx identities.
  const memoryEnabledCache = new Map<string, { enabled: boolean; deadline: number }>()
  const MEMORY_ENABLED_CACHE_MAX = 512
  const MEMORY_ENABLED_TTL_MS = 5_000

  /** Drop the cached enabled flag for a root so the next probe re-reads fresh state.
   * Called by the MemoryEvents subscriber in bootstrap on every state mutation. */
  export function invalidateMemoryEnabled(root: string) {
    memoryEnabledCache.delete(root)
  }

  /** Per-turn cache of `KiloMemory.toolEnabled` keyed by root string, with a short TTL so the
   * step-loop coalesces probes inside a single turn. Cache is invalidated immediately on enable /
   * disable / purge / rebuild via the MemoryEvents bus (subscribed in kilocode/bootstrap.ts). */
  export function memoryToolsEnabled(input: { ctx: MemoryPaths.Ctx }) {
    return Effect.gen(function* () {
      const root = MemoryPaths.root({ ctx: input.ctx })
      const cached = memoryEnabledCache.get(root)
      if (cached && cached.deadline > Date.now()) return cached.enabled
      const enabled = yield* Effect.tryPromise({
        try: () => KiloMemory.toolEnabled({ ctx: input.ctx }),
        catch: (err) => err,
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            log.warn("memory tools unavailable", { error: String(err) })
            return false
          }),
        ),
      )
      memoryEnabledCache.set(root, { enabled, deadline: Date.now() + MEMORY_ENABLED_TTL_MS })
      if (memoryEnabledCache.size > MEMORY_ENABLED_CACHE_MAX) {
        const oldest = memoryEnabledCache.keys().next().value
        if (oldest !== undefined) memoryEnabledCache.delete(oldest)
      }
      return enabled
    })
  }
  /** Hide Kilo memory tools from the model when project memory is disabled. */
  export const applyVisibility = Effect.fn("KiloToolRegistry.applyVisibility")(function* (tools: Tool.Def[]) {
    const ctx = yield* InstanceState.context
    const memoryEnabled = yield* memoryToolsEnabled({ ctx })
    return tools.filter((tool) => {
      if (tool.id.startsWith("kilo_memory_")) return memoryEnabled
      return true
    })
  })

  export function describe(tools: Tool.Def[], extra: { semantic?: Tool.Def }): Tool.Def[] {
    if (!extra.semantic) return tools
    return tools.map((tool) => {
      if (tool.id !== "glob" && tool.id !== "grep") return tool
      return { ...tool, description: `${tool.description}\n${hint}` }
    })
  }
}
