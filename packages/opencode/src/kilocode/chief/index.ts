// raya_change - Milestone B intelligent auto-routing
import { Schema } from "effect"

export namespace RayaChief {
  export const threshold = 0.7
  export const target = 0.9
  export const pendingKey = "raya.chief.pending"
  export const modelKey = "raya.chief.parentModel"
  export const logKey = "raya.chief.decisions"

  export const Role = Schema.Literals(["coder", "designer", "researcher", "accountant", "reasoner"])
  export type Role = typeof Role.Type

  export const Candidate = Schema.Struct({
    agent: Schema.String,
    role: Role,
    score: Schema.Number,
    reason: Schema.String,
  })
  export type Candidate = typeof Candidate.Type

  export const Decision = Schema.Struct({
    request: Schema.String,
    agent: Schema.String,
    model: Schema.String,
    needs_plan: Schema.Boolean,
    confidence: Schema.Number,
    reason: Schema.String,
    latency: Schema.Number,
    chiefModel: Schema.String,
    candidates: Schema.Array(Candidate),
    prompted: Schema.Boolean,
  })
  export type Decision = typeof Decision.Type

  export type Agent = {
    name: string
    description?: string
    model?: { providerID: string; modelID: string }
  }

  export type Pending = {
    request: string
    agent: string
    role: Role
    needs_plan: boolean
    confidence: number
    reason: string
    candidates: Candidate[]
    prompted: boolean
    latency: number
    chiefModel: string
  }

  type Profile = {
    role: Role
    names: readonly string[]
    terms: Readonly<Record<string, number>>
    reason: string
  }

  const profiles: readonly Profile[] = [
    {
      role: "accountant",
      names: ["accountant", "finance", "general"],
      terms: {
        accounting: 5,
        accountant: 5,
        bookkeeping: 5,
        ledger: 5,
        invoice: 4,
        reconcile: 4,
        reconciliation: 4,
        depreciation: 4,
        payroll: 4,
        tax: 4,
        financial: 3,
        journal: 3,
        expense: 2,
      },
      reason: "The request is primarily financial or accounting work.",
    },
    {
      role: "designer",
      names: ["designer", "design", "general"],
      terms: {
        figma: 5,
        ui: 4,
        ux: 4,
        visual: 4,
        mockup: 4,
        typography: 4,
        palette: 4,
        wireframe: 4,
        responsive: 3,
        layout: 3,
        animation: 2,
        screen: 2,
      },
      reason: "The request is primarily product or interface design work.",
    },
    {
      role: "reasoner",
      names: ["reasoner", "architect", "general"],
      terms: {
        architecture: 5,
        architectural: 5,
        theorem: 5,
        proof: 4,
        tradeoff: 4,
        tradeoffs: 4,
        distributed: 4,
        concurrency: 4,
        consistency: 4,
        threat: 4,
        security: 4,
        algorithm: 3,
        strategy: 3,
        reason: 2,
        complex: 2,
      },
      reason: "The request requires hard reasoning or architectural trade-off analysis.",
    },
    {
      role: "researcher",
      names: ["researcher", "explore", "general"],
      terms: {
        research: 5,
        investigate: 4,
        compare: 3,
        survey: 4,
        sources: 4,
        citations: 4,
        evidence: 3,
        literature: 4,
        discover: 3,
        documentation: 2,
        benchmark: 2,
        analyze: 2,
      },
      reason: "The request is primarily evidence-gathering or comparative research.",
    },
    {
      role: "coder",
      names: ["coder", "general"],
      terms: {
        implement: 4,
        code: 4,
        coding: 4,
        fix: 4,
        bug: 4,
        refactor: 4,
        test: 3,
        api: 3,
        function: 3,
        typescript: 3,
        javascript: 3,
        python: 3,
        database: 2,
        endpoint: 3,
        build: 2,
      },
      reason: "The request is primarily software implementation work.",
    },
  ]

  function tokens(input: string) {
    return input.toLowerCase().match(/[a-z0-9+#.-]+/g) ?? []
  }

  function score(input: string, profile: Profile) {
    const words = tokens(input)
    return words.reduce((total, word) => total + (profile.terms[word] ?? 0), 0)
  }

  function overlap(request: string, description?: string) {
    const words = new Set(tokens(request))
    return tokens(description ?? "").filter((word) => words.has(word)).length
  }

  function agent(profile: Profile, agents: readonly Agent[]) {
    return profile.names
      .map((name) => agents.find((item) => item.name === name))
      .find((item): item is Agent => item !== undefined)
  }

  export function route(input: { request: string; agents: readonly Agent[] }) {
    const ranked = profiles
      .map((profile) => {
        const selected = agent(profile, input.agents)
        return {
          profile,
          agent: selected,
          score: score(input.request, profile) + overlap(input.request, selected?.description),
        }
      })
      .filter((item): item is { profile: Profile; agent: Agent; score: number } => item.agent !== undefined)
      .toSorted((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name))
    const top = ranked[0]
    if (!top) throw new Error("Auto routing requires at least one eligible specialist")

    const next = ranked[1]?.score ?? 0
    const confidence =
      top.score === 0 ? 0.35 : next === top.score ? 0.55 : Math.min(0.98, 0.74 + top.score * 0.03 + (top.score - next) * 0.02)
    const candidates = ranked.slice(0, 3).map(
      (item): Candidate => ({
        agent: item.agent.name,
        role: item.profile.role,
        score: item.score,
        reason: item.profile.reason,
      }),
    )

    return {
      agent: top.agent.name,
      role: top.profile.role,
      needs_plan: top.profile.role === "reasoner",
      confidence,
      reason: top.profile.reason,
      candidates,
    }
  }

  export function needsPrompt(decision: Pick<ReturnType<typeof route>, "confidence">) {
    return decision.confidence < threshold
  }

  export function question(decision: Pick<ReturnType<typeof route>, "candidates">) {
    return {
      header: "Choose specialist",
      question: "Auto found more than one plausible specialist. Who should handle this request?",
      options: decision.candidates.map((item) => ({
        label: item.agent,
        description: `${item.role}: ${item.reason}`,
      })),
      multiple: false,
      custom: false,
    } as const
  }

  export function prompt(agents: readonly Agent[]) {
    const registry = agents
      .map(
        (item) =>
          `- ${item.name}: ${item.description ?? "No capability card"}${item.model ? ` [${item.model.providerID}/${item.model.modelID}]` : ""}`,
      )
      .join("\n")
    return `You are Raya's Chief router. For every new user request, call chief_route exactly once with the user's complete objective. Do not answer the request yourself and do not call task before chief_route succeeds. The route result is a strict decision containing agent, model, needs_plan, confidence, and reason. After it returns, call task exactly once; the runtime enforces the logged decision and delegates to the selected isolated specialist. When task completes, give the user a concise synthesis.

Registry:
${registry}`
  }

  export function pending(metadata: Record<string, unknown> | undefined) {
    const value = metadata?.[pendingKey]
    if (!value || typeof value !== "object") return undefined
    const item = value as Partial<Pending>
    if (typeof item.request !== "string" || typeof item.agent !== "string") return undefined
    if (!Schema.is(Role)(item.role)) return undefined
    if (typeof item.confidence !== "number" || typeof item.reason !== "string") return undefined
    if (typeof item.needs_plan !== "boolean" || typeof item.prompted !== "boolean") return undefined
    if (typeof item.latency !== "number" || typeof item.chiefModel !== "string") return undefined
    return item as Pending
  }

  export function parent(metadata: Record<string, unknown> | undefined) {
    const value = metadata?.[modelKey]
    if (!value || typeof value !== "object") return undefined
    const item = value as { providerID?: unknown; modelID?: unknown; variant?: unknown }
    if (typeof item.providerID !== "string" || typeof item.modelID !== "string") return undefined
    return {
      providerID: item.providerID,
      modelID: item.modelID,
      variant: typeof item.variant === "string" ? item.variant : undefined,
    }
  }

  export function history(metadata: Record<string, unknown> | undefined) {
    const value = metadata?.[logKey]
    if (!Array.isArray(value)) return [] as Decision[]
    return value.filter(Schema.is(Decision)).slice(-49)
  }
}
