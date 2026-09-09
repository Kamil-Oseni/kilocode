// raya_change - Milestone B intelligent auto-routing
import { Schema } from "effect"

export namespace RayaChief {
  export const threshold = 0.7
  export const target = 0.9
  export const pendingKey = "raya.chief.pending"
  export const modelKey = "raya.chief.parentModel"
  export const logKey = "raya.chief.decisions"
  export const requestKey = "raya.chief.request" // raya_change - Auto must route the user's exact request
  export const phaseKey = "raya.chief.phase" // raya_change - enforce the Chief → task → synthesis state machine
  export const lastStep =
    "Step budget reached; work continues. Do not call update_goal complete unless every requirement is proven by eligible callIDs from this session. If concrete work remains, call task. Never copy evidence or done-when text from another project." // raya_change - last Auto step must not fake-complete an unfinished goal

  // raya_change - route only user-authored text; synthetic goal and review guidance is policy, not intent
  export function requestText(parts: readonly { type: string; text?: string; synthetic?: boolean }[], goal?: string) {
    const text = parts
      .filter(
        (part): part is { type: string; text: string; synthetic?: boolean } =>
          part.type === "text" && typeof part.text === "string" && !part.synthetic,
      )
      .map((part) => part.text)
      .join("\n")
      .trim()
    return text || goal?.trim() || "" // raya_change - steered continuations have no new user-authored part
  }

  // raya_change start - Auto runtime state machine
  export type Phase = "route" | "task" | "goal" | "done"

  export function phase(metadata: Record<string, unknown> | undefined): Phase {
    const value = metadata?.[phaseKey]
    if (value === "task" || value === "goal" || value === "done") return value
    return "route"
  }

  export function begin(metadata: Record<string, unknown> | undefined, continuation?: boolean): Phase {
    if (!continuation) return "route"
    return "task"
  } // raya_change - steered and idle continuations skip Chief and may call task again

  export function request(metadata: Record<string, unknown> | undefined) {
    const value = metadata?.[requestKey]
    return typeof value === "string" && value.trim() ? value : undefined
  }

  export function tools<T>(available: Record<string, T>, metadata: Record<string, unknown> | undefined) {
    // raya_change start - Auto's prompt tells it to call ask_options when a genuine choice
    // only the user can make is blocking, so those clarification tools must survive the
    // whitelist or the model hits "Unknown tool: ask_options". When the user invoked
    // /canvas, Auto may also create and refine the live canvas directly (and follow the
    // host's update_canvas retry hint) instead of only through a delegated subagent.
    const names = ["chief_route", "task", "get_goal", "update_goal", "update_goal_plan", "ask_options", "question"]
    if (metadata?.["raya.canvas.command"] === true) names.push("create_canvas", "update_canvas")
    return Object.fromEntries(names.flatMap((name) => (available[name] ? [[name, available[name]]] : []))) as Record<
      string,
      T
    >
    // raya_change end - every orchestration call remains dispatchable even during final
    // synthesis; tool choice and handlers enforce ordering without producing misleading
    // Unknown tool failures
  }

  // raya_change end

  export const Role = Schema.Literals([
    "generalist",
    "coder",
    "engineer",
    "designer",
    "researcher",
    "accountant",
    "reasoner",
  ])
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
      role: "generalist",
      names: ["generalist", "general", "coder"],
      terms: {},
      reason: "The request is a small, direct task that does not need a specialist.",
    },
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
        redesign: 5,
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
        canvas: 5, // raya_change - Milestone E live visual artifacts
        dashboard: 4, // raya_change - Milestone E plain-English canvas intent
        chart: 3, // raya_change - Milestone E plain-English canvas intent
        interactive: 2, // raya_change - Milestone E plain-English canvas intent
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
        concurrent: 4,
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
      role: "engineer",
      names: ["engineer"],
      terms: {
        implement: 4,
        "lock-free": 5,
        lockfree: 5,
        deadlock: 5,
        mutex: 5,
        multithreaded: 5,
        consensus: 5,
        raft: 5,
        paxos: 5,
        sharding: 5,
        backpressure: 5,
        scheduler: 5,
        contention: 5,
        fsync: 5,
        wal: 5,
        mmap: 5,
        simd: 5,
        race: 4,
        concurrent: 4,
        replication: 4,
        invariant: 4,
        transactional: 4,
        serializable: 4,
        compiler: 4,
        interpreter: 4,
        saga: 4,
        throughput: 4,
        latency: 3,
        protocol: 3,
        engine: 3,
        durable: 3,
        systems: 3,
      },
      reason: "The request is difficult systems or correctness-sensitive implementation.",
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
        // raya_change start - plain-English website inspection routes to browser-capable research
        browse: 3,
        inspect: 3,
        website: 2,
        browser: 2,
        // raya_change end
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
        // raya_change start - browser flow verification routes to the coding specialist
        smoke: 4,
        e2e: 4,
        walkthrough: 2,
        browser: 2,
        // raya_change end
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

  // raya_change - cheap direct work should use the configured small model instead of a design or reasoning specialist
  function trivial(request: string) {
    const value = request.trim()
    if (value.length > 180 || tokens(value).length > 28) return false
    if (
      !/\b(?:add|answer|change|create|delete|explain|find|open|read|rename|replace|say|show|summarize|write)\b/i.test(
        value,
      )
    )
      return false
    return !/\b(?:accounting|architecture|audit|backpressure|benchmark|codebase|concurrency|concurrent|consensus|deadlock|design system|endpoint|evidence|figma|implement|investigate|lock-free|migration|multithreaded|payroll|product|raft|refactor|research|scheduler|security|suite|tradeoffs?|ui|ux|validation|webhook|website)\b/i.test(
      value,
    )
  }

  // raya_change - listing or sequencing a redesign is not Designer work
  function listing(request: string) {
    return (
      /\b(?:do not|don't|dont|just|only|without)\b.{0,40}\b(?:design|redesign|implement|code|build)\b/i.test(request) ||
      /\b(?:list|enumerate|rank)\b.{0,80}\b(?:order|sequence|pages?)\b/i.test(request)
    )
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
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          (a.profile.role === "engineer" ? 1 : 0) - (b.profile.role === "engineer" ? 1 : 0) ||
          a.agent.name.localeCompare(b.agent.name),
      )
    const first = ranked[0]
    if (!first) throw new Error("Auto routing requires at least one eligible specialist")
    const quick = ranked.find((item) => item.profile.role === "generalist")
    const direct = trivial(input.request)
    const outline = listing(input.request)
    // raya_change - zero-signal conversational requests should proceed through a capable generalist instead of prompting
    const top = (outline || direct) && quick ? quick : first.score === 0 ? (quick ?? first) : first

    const next = ranked.find((item) => item !== top)?.score ?? 0
    const confidence =
      top.profile.role === "generalist" && (direct || outline)
        ? 0.94
        : top.score === 0
          ? 0.35
          : next === top.score
            ? 0.55
            : Math.min(0.98, 0.74 + top.score * 0.03 + (top.score - next) * 0.02)
    const candidates = [top, ...ranked.filter((item) => item !== top)].slice(0, 3).map(
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

  export function needsPrompt(
    decision: Pick<ReturnType<typeof route>, "confidence"> & Partial<Pick<ReturnType<typeof route>, "candidates">>,
    configured: number = threshold, // raya_change - Milestone I routing settings
    request?: string, // raya_change - preserve explicit ambiguity while allowing smooth conversational turns
  ) {
    const value = Number.isFinite(configured) ? Math.min(1, Math.max(0, configured)) : threshold // raya_change
    if (decision.confidence >= value) return false
    if (!request || !decision.candidates) return true
    if (decision.candidates.some((item) => item.score > 0)) return true
    return /\b(help me decide|not sure|which (?:agent|specialist)|who should|what should i do)\b/i.test(request)
  }

  // raya_change start - Milestone C low-confidence selectable contract
  export function question(decision: Pick<ReturnType<typeof route>, "candidates">) {
    return {
      prompt: "Auto found more than one plausible specialist. Who should handle this request?",
      options: decision.candidates.map((item) => ({
        id: item.agent,
        label: item.agent,
      })),
      allow_multiple: false,
    } as const
  }
  // raya_change end

  export function prompt(agents: readonly Agent[]) {
    const registry = agents
      .map(
        (item) =>
          `- ${item.name}: ${item.description ?? "No capability card"}${item.model ? ` [${item.model.providerID}/${item.model.modelID}]` : ""}`,
      )
      .join("\n")
    return `You are Raya's Chief router. Do not inspect the repository, answer the request, narrate an approach, or name a tool that is not currently available. Make exactly one tool call per response and wait for its result before choosing the next call. On a new user request, first call chief_route exactly once; its runtime uses the user's original request, regardless of how you phrase the objective argument. After it returns, call task exactly once. On a continuation, skip chief_route and call task if concrete work remains. When a genuine choice only the user can make is blocking the request, call ask_options with concrete labeled choices and wait for the answer before routing or delegating. When the delegated work is done, call get_goal. If a goal exists, formally complete or honestly block it with update_goal; if no goal exists, give the concise synthesis directly. After goal handling, give the user a concise synthesis without another tool call. Never write tool-call markup as prose. Never invent a tool name.

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

  export function follow(metadata: Record<string, unknown> | undefined) {
    const ready = pending(metadata)
    if (ready) return ready
    const last = history(metadata).at(-1)
    if (!last) return undefined
    const role = last.candidates.find((item: Candidate) => item.agent === last.agent)?.role
    if (!role) return undefined
    return { ...last, role } satisfies Pending
  } // raya_change - later Auto tasks reuse the logged specialist after pending is consumed
}
