import { randomUUID, createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type {
  ManageSource,
  Manage,
  ManageResult,
} from "../../../opencode/src/kilocode/second-brain/management-protocol"
import { valid } from "../../../opencode/src/kilocode/second-brain/management-source"
import { Candidates, Proposal, type Candidate } from "./management-wire"
import type { CaptureBinding } from "./capture-intake"

type Command = Manage
export type ManagementAuthority = {
  current(): boolean
  source(): Promise<ManageSource | undefined>
}
type Binding = { selection: CaptureBinding; policy: string }
type Publication = {
  published: boolean
  indexed: boolean
  changes: { relative: string; note_sha256: string | null }[]
}
type Attempt = {
  id: string
  command: Command
  project: string
  binding: Binding
  authority: ManagementAuthority
  until: number
  busy: boolean
  closed: boolean
  options: Map<string, { label: string; category?: string; candidate?: Candidate; review?: true; cancel?: true }>
  category?: string
  candidate?: Candidate
  proposal?: Proposal
  result?: ManageResult
}
type Input = {
  bind(signal: AbortSignal, check: () => void): Promise<Binding>
  current(binding: Binding): boolean
  execute(body: Record<string, unknown>, signal: AbortSignal, check: () => void): Promise<unknown>
  review(proposal: Proposal, signal: AbortSignal, check: () => void): Promise<boolean>
  publish(
    proposal: Proposal,
    binding: Binding,
    signal: AbortSignal,
    authorize: (admitted?: true) => Promise<void>,
  ): Promise<Publication>
}
const categories = ["Daily", "Preferences", "People", "Projects", "Areas", "Commitments", "Decisions"]
// The wire decoder deliberately uses null prototypes. Validate the JSON shape
// before comparing values; prototypes are not conversation provenance.
const lineage = z
  .object({
    action: z.literal("preview"),
    project: z.string(),
    id: z.string(),
    mode: z.enum(["remember", "correct", "forget"]),
    source: z
      .object({
        sessionID: z.string(),
        messageID: z.string(),
        created_utc: z.string(),
        text: z.string(),
        source_sha256: z.string(),
      })
      .strict(),
    expected_policy_sha256: z.string(),
    fact: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict().optional(),
    candidate: z.string().optional(),
    category: z.enum(["Daily", "Preferences", "People", "Projects", "Areas", "Commitments", "Decisions"]).optional(),
  })
  .strict()
function proposal(value: unknown): Proposal {
  const parsed = Proposal.parse(value)
  return { ...parsed, management: lineage.parse(parsed.management) }
}
const base = (command: Command) => ({
  operation: command.operation,
  mode: command.mode,
  source: command.source,
  fact: command.fact,
  query: command.query,
})

/** Host-only nonce choices and exact native review; uncertain publication is never replayed. */
export class ManagementFlow {
  private attempts = new Map<string, Attempt>()
  private closed = false
  constructor(private readonly input: Input) {}

  close() {
    this.closed = true
    for (const attempt of this.attempts.values()) attempt.closed = true
  }

  async run(command: Command, project: string, authority: ManagementAuthority, signal: AbortSignal, guard: () => void) {
    if (!valid({ ...base(command), action: "manage", stage: "inspect" }))
      throw new Error("Exact original personal Memory request required")
    guard()
    signal.throwIfAborted()
    if (this.closed) throw new Error("Original personal Memory host closed")
    const { attempt, prior } = await this.retain(command, project, authority, signal, guard)
    if (attempt.result) return attempt.result
    const check = (admitted?: true) => {
      signal.throwIfAborted()
      guard()
      if (
        this.closed ||
        attempt.closed ||
        attempt.until < Date.now() ||
        !attempt.authority.current() ||
        !authority.current() ||
        (!admitted && !this.input.current(attempt.binding))
      )
        throw new Error("Original personal Memory selection or connection changed")
    }
    const authorize = async (admitted?: true) => {
      check(admitted)
      const source = await attempt.authority.source()
      check(admitted)
      if (!isDeepStrictEqual(source, attempt.command.source)) throw new Error("Original user Memory request changed")
    }
    attempt.busy = true
    try {
      await authorize()
      if (command.stage === "cancel") return await this.cancel(attempt, signal, check)
      if (command.stage === "inspect" && prior) return this.choice(attempt)
      if (command.stage === "select" || command.stage === "review") {
        const selected = await this.select(attempt, command, signal, check, authorize)
        if (selected) return selected
      }
      return await this.progress(attempt, signal, check, authorize)
    } catch (err) {
      attempt.closed = true
      attempt.result = this.receipt(attempt, "unconfirmed")
      console.warn(
        "[Raya] Original personal Memory change remains unconfirmed",
        err instanceof Error ? err.name : "Unknown",
      )
      return attempt.result
    } finally {
      attempt.busy = false
    }
  }

  private async retain(
    command: Command,
    project: string,
    authority: ManagementAuthority,
    signal: AbortSignal,
    guard: () => void,
  ) {
    const prior = this.attempts.get(command.operation)
    if (prior && (!isDeepStrictEqual(base(prior.command), base(command)) || prior.project !== project))
      throw new Error("Original personal Memory source or project changed")
    if (prior?.busy) throw new Error("Original personal Memory change is still running")
    if (!prior && command.stage !== "inspect") throw new Error("Original personal Memory attempt required")
    if (!prior && this.attempts.size >= 128) throw new Error("Personal Memory attempts need original-ID review")
    const attempt: Attempt = prior ?? {
      id: randomUUID(),
      command: structuredClone(command),
      project,
      binding: await this.input.bind(signal, guard),
      authority,
      until: Date.now() + 600000,
      busy: false,
      closed: false,
      options: new Map(),
    }
    if (prior && command.stage !== "inspect" && command.attempt !== attempt.id)
      throw new Error("Original host Memory nonce required")
    this.attempts.set(command.operation, attempt)
    return { attempt, prior: Boolean(prior) }
  }

  private async select(
    attempt: Attempt,
    command: Command,
    signal: AbortSignal,
    check: () => void,
    authorize: (admitted?: true) => Promise<void>,
  ) {
    if (command.stage === "select" || command.stage === "review") {
      const choice = attempt.options.get(command.choice ?? "")
      if (!choice) throw new Error("Choose one original host Memory option")
      if (choice.cancel) return await this.cancel(attempt, signal, check)
      if (command.stage === "review" && !choice.review) throw new Error("Original review choice required")
      if (command.stage === "select" && choice.review) throw new Error("Review stage required")
      if (choice.category) attempt.category = choice.category
      if (choice.candidate) attempt.candidate = choice.candidate
      attempt.options.clear()
      if (choice.review) return this.confirm(attempt, signal, check, authorize)
    }
  }

  private async confirm(
    attempt: Attempt,
    signal: AbortSignal,
    check: () => void,
    authorize: (admitted?: true) => Promise<void>,
  ) {
    const command = attempt.command
    const project = attempt.project
    if (!attempt.proposal) throw new Error("Original pending proposal required")
    const planned = proposal(
      await this.input.execute({ action: "read", project, id: command.operation }, signal, check),
    )
    await authorize()
    if (!isDeepStrictEqual(planned, attempt.proposal) || planned.status !== "pending")
      throw new Error("Original personal Memory proposal changed")
    if (!(await this.input.review(planned, signal, check))) return await this.cancel(attempt, signal, check)
    await authorize()
    const current = proposal(
      await this.input.execute({ action: "read", project, id: command.operation }, signal, check),
    )
    await authorize()
    if (!isDeepStrictEqual(current, planned)) throw new Error("Personal Memory proposal changed during native review")
    const value = await this.input.publish(planned, attempt.binding, signal, authorize)
    attempt.closed = true
    attempt.result = this.receipt(
      attempt,
      value.indexed ? "indexed" : value.published ? "published" : "unconfirmed",
      value,
    )
    return attempt.result
  }

  private async progress(
    attempt: Attempt,
    signal: AbortSignal,
    check: () => void,
    authorize: (admitted?: true) => Promise<void>,
  ) {
    const command = attempt.command
    const project = attempt.project
    if (command.mode === "remember") {
      const category = this.category(attempt)
      if (category) return category
    }
    if (command.mode !== "remember") {
      const target = await this.targets(attempt, signal, check, authorize)
      if (target) return target
    }
    const preview = {
      action: "preview",
      project,
      id: command.operation,
      mode: command.mode,
      source: command.source,
      expected_policy_sha256: attempt.binding.policy,
      ...(command.fact ? { fact: command.fact } : {}),
      ...(attempt.candidate ? { candidate: attempt.candidate.id } : {}),
      ...(attempt.category ? { category: attempt.category } : {}),
    }
    const planned = proposal(await this.input.execute(preview, signal, check))
    await authorize()
    if (planned.id !== command.operation || planned.project !== project || planned.status !== "pending")
      throw new Error("Original personal Memory preview differs")
    if (!isDeepStrictEqual(planned.management, preview))
      throw new Error("Original conversation proposal provenance differs")
    attempt.proposal = planned
    attempt.options.set(randomUUID(), { label: "Review exact changes", review: true })
    return this.choice(attempt, "Review this personal Memory change before publishing it?")
  }

  private category(attempt: Attempt) {
    const command = attempt.command
    if (command.mode === "remember" && !attempt.category) {
      const text = command.source.text.slice(command.fact!.start, command.fact!.end)
      const parts = text.split(/[.!?;\n]|\bbut\b/i)
      const dated =
        /\b(?:dated|date-stamped)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i.test(
          text,
        )
      const project = parts.some(
        (part) =>
          !/\b(?:not|no|never)\b[^.!?;\n]{0,60}\bproject\b/i.test(part) &&
          /\bproject\b/i.test(part) &&
          /\b(?:observation|setup|test outcome|checkpoint)\b/i.test(part),
      )
      const preference = parts.some(
        (part) =>
          !/\b(?:not|no|never)\b[^.!?;\n]{0,60}\bprefer(?:ence|ences)?\b/i.test(part) &&
          /\b(?:I|we)\s+(?:really\s+)?prefer\b|\bmy\s+(?:personal\s+)?preferences?\s+(?:is|are)\b/i.test(part),
      )
      const observation = dated && project
      if (observation && !preference) attempt.category = "Projects"
      if (preference && !observation) attempt.category = "Preferences"
      if (!attempt.category) {
        for (const category of categories) attempt.options.set(randomUUID(), { label: category, category })
        return this.choice(attempt, "Which category should hold this exact personal memory?")
      }
    }
  }

  private async targets(
    attempt: Attempt,
    signal: AbortSignal,
    check: () => void,
    authorize: (admitted?: true) => Promise<void>,
  ) {
    const command = attempt.command
    const project = attempt.project
    if (command.mode !== "remember" && !attempt.candidate) {
      const value = Candidates.parse(
        await this.input.execute(
          { action: "candidates", project, query: command.query, expected_policy_sha256: attempt.binding.policy },
          signal,
          check,
        ),
      )
      await authorize()
      if (!value.candidates.length) {
        attempt.closed = true
        attempt.result = this.receipt(attempt, "no_match")
        return attempt.result
      }
      if (value.truncated) throw new Error("Narrow the personal Memory target before selecting an entry")
      for (const candidate of value.candidates)
        if (createHash("sha256").update(candidate.excerpt).digest("hex") !== candidate.excerpt_sha256)
          throw new Error("Original entry excerpt differs")
      if (value.candidates.length === 1) attempt.candidate = value.candidates[0]
      if (value.candidates.length > 1) {
        for (const candidate of value.candidates) {
          attempt.options.set(randomUUID(), {
            label: `${candidate.relative}: ${candidate.excerpt.replace(/\s+/g, " ").slice(0, 180)}`.slice(0, 100),
            candidate,
          })
        }
        return this.choice(attempt, "Which exact personal memory should change?")
      }
    }
  }

  private async cancel(attempt: Attempt, signal: AbortSignal, check: () => void) {
    if (attempt.proposal) {
      const planned = proposal(
        await this.input.execute(
          {
            action: "cancel",
            project: attempt.project,
            id: attempt.command.operation,
            digest: attempt.proposal.digest,
          },
          signal,
          check,
        ),
      )
      if (planned.status !== "cancelled") throw new Error("Original cancellation was not confirmed")
    }
    attempt.closed = true
    attempt.result = this.receipt(attempt, "cancelled")
    return attempt.result
  }

  private choice(attempt: Attempt, prompt = "Continue the original personal Memory choice?") {
    if (![...attempt.options.values()].some((value) => value.cancel))
      attempt.options.set(randomUUID(), { label: "Cancel", cancel: true })
    return {
      ...this.receipt(attempt, "pending"),
      attempt: attempt.id,
      stage: attempt.proposal ? ("review" as const) : ("select" as const),
      ...(attempt.proposal ? { proposal: attempt.proposal.id } : {}),
      question: { prompt, options: [...attempt.options].map(([id, value]) => ({ id, label: value.label })) },
    }
  }

  private receipt(
    attempt: Attempt,
    disposition: "pending" | "cancelled" | "published" | "indexed" | "no_match" | "unconfirmed",
    value?: Publication,
  ): ManageResult {
    const command = attempt.command
    return {
      action: "manage" as const,
      project: attempt.project,
      operation: command.operation,
      attempt: attempt.id,
      sessionID: command.source.sessionID,
      messageID: command.source.messageID,
      source_sha256: command.source.source_sha256,
      mode: command.mode,
      disposition,
      publication_confirmed: value?.published ?? false,
      index_confirmed: value?.indexed ?? false,
      changes: value?.changes ?? [],
      ...(attempt.proposal ? { proposal: attempt.proposal.id } : {}),
    }
  }
}
