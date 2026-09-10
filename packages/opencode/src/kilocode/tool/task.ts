// kilocode_change - new file
import { Effect, Schema } from "effect"
import path from "path"
import { Permission } from "@/permission"
import { guarded } from "../agent"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Session } from "../../session/session"
import type { Agent } from "../../agent/agent"
import type { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { RayaToolModel } from "@/kilocode/chief/tool-model"
import z from "zod"

// raya_change start - Milestone D automatic Chief routing and bounded child runs
const STEP_KEY = "raya.task.stepCap"
const DEFAULT_CAP = 40
const MAX_CAP = 80
const ignored = new Set([
  "agent",
  "and",
  "for",
  "from",
  "into",
  "the",
  "this",
  "that",
  "task",
  "use",
  "when",
  "with",
  "paths",
  "path",
  "work",
])

function words(value: string) {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !ignored.has(word)),
  )
}

function profile(name: string) {
  if (name === "explore") return ["codebase", "find", "inspect", "locate", "map", "search", "where"]
  if (name === "scout") return ["dependency", "documentation", "external", "library", "package", "reference", "source"]
  if (name === "engineer")
    return [
      "backpressure",
      "concurrent",
      "consensus",
      "deadlock",
      "latency",
      "multithreaded",
      "raft",
      "scheduler",
      "sharding",
    ]
  return []
}
// raya_change end

// RATIONALE: Mirror narrow state slice Task tool consumes and ignore unrelated TUI fields.
const ModelState = z
  .object({
    model: z
      .record(
        z.string(),
        z.object({
          providerID: z.custom<ProviderV2.ID>(Schema.is(ProviderV2.ID)),
          modelID: z.custom<ModelV2.ID>(Schema.is(ModelV2.ID)),
        }),
      )
      .optional(),
    variant: z.record(z.string(), z.string().optional()).optional(),
  })
  .passthrough()

export namespace KiloTask {
  // raya_change start - Milestone D task contract
  export type Candidate = Pick<Agent.Info, "name" | "description" | "mode" | "hidden" | "deprecated">
  export type Brief = {
    objective: string
    context?: string
    constraints?: readonly string[]
    expected_return?: string
  }

  export function route(input: { request: string; agents: Candidate[] }) {
    const request = words(input.request)
    const ranked = input.agents
      .filter((item) => item.mode !== "primary" && !item.hidden && !item.deprecated)
      .map((item) => {
        const name = item.name.toLowerCase()
        const description = words(item.description ?? "")
        const overlap = [...description].filter((word) => request.has(word)).length
        const exact = request.has(name) ? 20 : 0
        const specialist = profile(name).filter((word) => request.has(word)).length * 5
        const fallback = name === "general" || name === "generalist" || name === "coder" ? 0 : 1
        return { item, score: exact + overlap * 2 + specialist + fallback }
      })
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    const selected = ranked[0]?.item
    if (!selected) throw new Error("No eligible subagent is available for automatic routing")
    if (selected.name === "general" || selected.name === "generalist" || selected.name === "coder") return selected
    if (
      /\b(?:do not|don't|dont|just|only|without)\b.{0,40}\b(?:design|redesign|implement|code|build)\b/i.test(
        input.request,
      ) ||
      /\b(?:list|enumerate|rank)\b.{0,80}\b(?:order|sequence|pages?)\b/i.test(input.request)
    ) {
      return ranked.find((item) => item.item.name === "general" || item.item.name === "generalist")?.item ?? selected
    }
    if (ranked[0]!.score > 1) return selected
    return ranked.find((item) => item.item.name === "general" || item.item.name === "generalist")?.item ?? selected
  }

  export function cap(value?: number) {
    if (value === undefined || !Number.isFinite(value)) return DEFAULT_CAP
    return Math.max(1, Math.min(MAX_CAP, Math.floor(value)))
  }

  export function steps(agent: number | undefined, metadata: Record<string, unknown> | undefined) {
    if (metadata?.["raya.goal.open"] === true) return Infinity
    const value = metadata?.[STEP_KEY]
    const task = typeof value === "number" && Number.isFinite(value) ? cap(value) : Infinity
    return Math.min(agent ?? Infinity, task)
  }

  export function metadata(current: Record<string, unknown> | undefined, value?: number) {
    return { ...current, [STEP_KEY]: cap(value) }
  }

  export function brief(input: { prompt?: string; brief?: Brief; cap: number }) {
    const objective = input.brief?.objective.trim() || input.prompt?.trim()
    if (!objective) throw new Error("Task requires brief.objective or prompt")
    return [
      "<subagent_brief>",
      `Objective: ${objective}`,
      ...(input.brief?.context ? [`Context: ${input.brief.context.trim()}`] : []),
      ...(input.brief?.constraints?.length
        ? ["Constraints:", ...input.brief.constraints.map((item) => `- ${item.trim()}`).filter((item) => item !== "- ")]
        : []),
      `Step cap: ${input.cap}`,
      `Expected return: ${
        input.brief?.expected_return?.trim() ||
        "A concise synthesized result with conclusions, evidence, and artifact paths; do not return the raw transcript."
      }`,
      "</subagent_brief>",
    ].join("\n")
  }
  // raya_change end

  /** Reject primary agents used as subagents */
  export function validate(info: Agent.Info, name: string) {
    if (info.mode === "primary") throw new Error(`Agent "${name}" is a primary agent and cannot be used as a subagent`)
  }

  /**
   * Build inherited permission ceilings from the calling agent.
   * Merges the static agent definition with the session's accumulated permissions
   * so denials survive multi-hop chains (plan → general → explore) without
   * overriding the selected subagent's own allowlist with parent ask/allow rules.
   *
   * OpenCode removed parent-agent inheritance entirely in anomalyco/opencode#31696.
   * Kilo intentionally differs: parent edit/notebook/MCP denials remain hard ceilings
   * for Plan Mode and MCP restrictions, while parent ask/allow rules must not replace
   * the selected subagent's policy. Preserve this distinction during upstream merges.
   *
   * Broad bash denies are deliberately NOT inherited from the calling agent. A read-only/delegating
   * agent (plan, ask, orchestrator) carries a `readOnlyBash` allowlist whose deny rules
   * (`*`, `git *`, shell-operator guards) exist only to shape that allowlist. Projecting
   * those denies onto a writable subagent capped commands the subagent's own config
   * explicitly allows (e.g. `git status`), surfacing phantom deny rules the user never
   * wrote (#11523). The subagent's own bash policy governs its bash capabilities; an
   * explicit session-scoped bash lockdown (sandbox / session deny) still reaches the
   * child via `deriveSubagentSessionPermission`, which inherits session deny rules. Built-in
   * Explore has its own enforcement-level read-only bash policy, so every caller retains that
   * boundary without projecting a delegator's bash rules onto custom writable subagents.
   *
   * The caller must resolve `caller` (Agent.Info) and `session` (Session.Info)
   * before calling. This function is pure/synchronous.
   */
  export function inherited(input: {
    caller: Agent.Info
    session: Pick<Session.Info, "permission">
    mcp: Config.Info["mcp"]
  }): Permission.Ruleset {
    const rules = Permission.merge(input.caller.permission ?? [], input.session.permission ?? [])
    const prefixes = Object.keys(input.mcp ?? {}).map((k) => k.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
    const isMcp = (p: string) => prefixes.some((prefix) => p.startsWith(prefix))
    // `guarded` covers the tools a read-only mode may never regain from config; keeping
    // it here too stops a Plan-launched subagent from reaching them under a catch-all.
    // `bash` is intentionally excluded — see the doc comment above (#11523).
    const mutation = new Set(["edit", ...guarded.filter((p) => p !== "bash")])
    const inherited = rules.filter(
      (r: Permission.Rule) => r.action === "deny" && (mutation.has(r.permission) || isMcp(r.permission)),
    )
    for (const permission of mutation) {
      if (Permission.evaluate(permission, "*", rules).action !== "deny") continue
      inherited.push({ permission, pattern: "*", action: "deny" })
    }
    return merge(inherited)
  }

  /** Extra permission rules appended to subagent sessions */
  export function permissions(rules: Permission.Ruleset, task = false): Permission.Ruleset {
    return [
      ...(task ? [] : [{ permission: "task", pattern: "*", action: "deny" as const }]),
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "ask_options", pattern: "*", action: "deny" }, // raya_change - Milestone C
      { permission: "suggest", pattern: "*", action: "deny" },
      { permission: "interactive_terminal", pattern: "*", action: "deny" },
      ...rules,
    ]
  }

  export function merge(...rulesets: Permission.Ruleset[]): Permission.Rule[] {
    const result: Permission.Rule[] = []
    const seen = new Set<string>()
    for (const rule of rulesets.flat()) {
      const key = `${rule.permission}\u0000${rule.pattern}\u0000${rule.action}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(rule)
    }
    return result
  }

  type Model = { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  type Saved = Model & { variant?: string }
  type Source = "workflow" | "saved-agent" | "agent-config" | "small-config" | "subagent-config" | "parent"
  type Choice = { model: Model; variant?: string; sticky?: boolean; source: Source }
  type Provenance = {
    version: 1
    stage: "selected"
    model: Model
    variant?: string
    source: Source
    variantSource: Source | "model-override" | "none"
    capability: "normalized-provider-flag"
  }
  type Workflow = { model: Model; variant?: string }

  function key(model: Model) {
    return `${model.providerID}/${model.modelID}`
  }

  function parse(value: string | null | undefined): Model | undefined {
    if (!value) return undefined
    const [providerID, ...parts] = value.split("/")
    return {
      providerID: ProviderV2.ID.make(providerID),
      modelID: ModelV2.ID.make(parts.join("/")),
    }
  }

  const saved = Effect.fn("KiloTask.savedModel")(function* (name: string) {
    if (Flag.KILO_CLIENT !== "cli") return undefined
    const file = path.join(Global.Path.state, "model.json")
    const state = yield* Effect.tryPromise({
      try: () =>
        Bun.file(file)
          .text()
          .then((raw) => ModelState.safeParse(JSON.parse(raw)))
          .then((result) => (result.success ? result.data : undefined))
          .catch(() => undefined),
      catch: () => undefined,
    })
    const model = state?.model?.[name]
    if (!model) return undefined
    return {
      ...model,
      variant: state?.variant?.[`${model.providerID}/${model.modelID}`],
    }
  })

  /** Preserve the highest-priority selected model; a missing or incompatible choice is not permission to replace it. */
  export const resolveModel = Effect.fn("KiloTask.resolveModel")(function* (input: {
    name: string
    agent: Pick<Agent.Info, "model" | "variant">
    config: Pick<Config.Info, "small_model" | "subagent_model" | "subagent_variant" | "subagent_variant_overrides">
    parent: Model
    variant?: string
    workflow?: Workflow
    provider: Provider.Interface
  }) {
    const state = yield* saved(input.name)
    const cfg = parse(input.config.subagent_model)
    const fast = input.name === "generalist" ? parse(input.config.small_model ?? undefined) : undefined // raya_change
    const override = (model: Model) => input.config.subagent_variant_overrides?.[key(model)] ?? undefined
    const choices: Array<Choice | undefined> = [
      input.workflow ? { ...input.workflow, source: "workflow" } : undefined,
      state
        ? {
            model: { providerID: state.providerID, modelID: state.modelID },
            variant: state.variant,
            sticky: true,
            source: "saved-agent",
          }
        : undefined,
      input.agent.model
        ? { model: input.agent.model, variant: input.agent.variant, source: "agent-config" }
        : undefined,
      fast ? { model: fast, source: "small-config" } : undefined, // raya_change - route trivial work through the user's swappable small model
      cfg ? { model: cfg, variant: input.config.subagent_variant ?? undefined, source: "subagent-config" } : undefined,
    ]

    const choice: Choice = choices.find((item) => item !== undefined) ?? {
      model: input.parent,
      variant: input.variant,
      source: "parent",
    }
    const full = yield* RayaToolModel.ensure(input.provider, choice.model)
    const configured = override(choice.model)
    const variant = yield* RayaToolModel.variant(full, configured ?? choice.variant)
    const provenance: Provenance = {
      version: 1,
      stage: "selected",
      model: { providerID: choice.model.providerID, modelID: choice.model.modelID },
      ...(variant === undefined ? {} : { variant }),
      source: choice.source,
      variantSource: variant === undefined ? "none" : configured !== undefined ? "model-override" : choice.source,
      capability: "normalized-provider-flag",
    }
    return {
      model: choice.sticky && variant ? { ...choice.model, variant } : choice.model,
      variant,
      provenance,
    }
  })

  export function workflow(value: unknown): Workflow | undefined {
    if (!value || typeof value !== "object") return undefined
    const item = (value as { workflow?: unknown }).workflow
    if (!item || typeof item !== "object") return undefined
    const model = (item as { model?: unknown }).model
    if (!model || typeof model !== "object") return undefined
    const providerID = (model as { providerID?: unknown }).providerID
    const modelID = (model as { modelID?: unknown }).modelID
    if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
    const variant = (item as { variant?: unknown }).variant
    return {
      model: { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) },
      variant: typeof variant === "string" ? variant : undefined,
    }
  }
}
