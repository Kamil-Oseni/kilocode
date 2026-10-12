import { randomUUID } from "node:crypto"
import { question } from "../shared/memory-setup-question"
import type { BrainState, BrainCapture } from "../shared/second-brain"

type Snapshot = {
  configured: boolean
  root?: string
  index: NonNullable<BrainState["control"]>["status"]
  capture: BrainCapture["status"]
  recovery?: boolean
}
type Stage = "connect" | "notes" | "index" | "capture"
type Model = { providerID: string; modelID: string }
type Command =
  | { stage: "inspect"; model?: Model }
  | { stage: "continue"; attempt: string; choice: string }
  | { stage: "cancel"; attempt: string }
type Attempt = {
  id: string
  scope: string
  expires: number
  stage?: Stage
  model?: Model
  selection?: string
  busy: boolean
  closed: boolean
}
type Input = {
  snapshot(): Promise<Snapshot>
  prepared(): Promise<{ root: string; capture: boolean; identity: string; fresh?: boolean } | undefined>
  connect(check: () => void, model?: Model, signal?: AbortSignal): Promise<boolean>
  notes(check: () => void, model?: Model, signal?: AbortSignal): Promise<boolean>
  index(check: () => void, model?: Model, signal?: AbortSignal): Promise<boolean>
  capture(check: () => void, model?: Model, signal?: AbortSignal): Promise<boolean>
}

/** One bounded host-owned setup. Cancellation never replays a completed setup stage. */
export class SetupFlow {
  private readonly attempts = new Map<string, Attempt>()
  constructor(private readonly input: Input) {}

  async run(command: Command, scope: string, project: string, signal: AbortSignal, guard: () => void) {
    guard()
    signal.throwIfAborted()
    const { attempt, fresh } = this.lookup(command, scope)
    if (command.stage === "cancel") {
      attempt.closed = true
      return this.result(
        attempt,
        project,
        "cancelled",
        await this.input.snapshot(),
        "Setup paused. Your conversation and completed steps are preserved.",
      )
    }
    if (attempt.busy) throw new Error("The original Memory setup stage is still running")
    const check = () => {
      guard()
      signal.throwIfAborted()
      if (attempt.closed || attempt.expires < Date.now())
        throw new Error("Original Memory setup was cancelled or expired")
    }
    attempt.busy = true
    try {
      const prepared = await this.input.prepared()
      check()
      if (fresh) attempt.selection = prepared?.identity
      if (attempt.selection !== prepared?.identity) throw new Error("Prepared Memory selection changed during setup")
      if (command.stage === "continue") {
        if (!attempt.stage || command.choice !== question(attempt.stage, "").options[0].id)
          throw new Error("Original Memory setup choice differs")
        const completed = await this.input[attempt.stage](check, attempt.model, signal)
        check()
        if (!completed) {
          attempt.closed = true
          return this.result(
            attempt,
            project,
            "cancelled",
            await this.input.snapshot(),
            "Setup paused. Your conversation and completed steps are preserved.",
          )
        }
      }
      return this.next(attempt, project, prepared, check)
    } catch (err) {
      attempt.closed = true
      throw err
    } finally {
      attempt.busy = false
      if (signal.aborted) attempt.closed = true
    }
  }

  private lookup(command: Command, scope: string) {
    const active = [...this.attempts.values()].find((row) => row.busy || (!row.closed && row.expires >= Date.now()))
    if (command.stage === "inspect" && active && (active.busy || active.scope !== scope))
      throw new Error("Resume or cancel the original Memory setup before starting another")
    const attempt =
      command.stage === "inspect"
        ? (active ??
          ({
            id: randomUUID(),
            scope,
            model: command.model,
            expires: Date.now() + 600000,
            busy: false,
            closed: false,
          } as Attempt))
        : this.attempts.get(command.attempt)
    if (!attempt || attempt.scope !== scope || attempt.closed || attempt.expires < Date.now())
      throw new Error("Original Memory setup attempt expired or changed")
    if (command.stage === "inspect") {
      this.attempts.clear()
      this.attempts.set(attempt.id, attempt)
    }
    return { attempt, fresh: command.stage === "inspect" && !active }
  }

  private async next(
    attempt: Attempt,
    project: string,
    prepared: Awaited<ReturnType<Input["prepared"]>>,
    check: () => void,
  ) {
    const state = await this.input.snapshot()
    check()
    const stage: Stage | undefined =
      !state.configured || state.recovery
        ? "connect"
        : ["unchecked", "policy_disabled"].includes(state.index)
          ? "notes"
          : state.index === "approved"
            ? "index"
            : state.index === "synced" && state.capture === "unavailable" && (prepared?.capture || attempt.model)
              ? "capture"
              : undefined
    attempt.stage = stage
    if (stage === "connect" && (!prepared || (state.recovery && !prepared.fresh))) {
      attempt.closed = true
      return this.result(
        attempt,
        project,
        "needs_attention",
        state,
        state.recovery
          ? "A reviewed fresh Memory setup is needed to preserve and recover the earlier attempt."
          : "Local memory has not been prepared by the installer yet. Your conversation is preserved.",
      )
    }
    if (stage)
      return {
        ...this.result(attempt, project, "choice", state),
        question: question(stage, state.root ?? prepared!.root),
      }
    attempt.closed = true
    return this.result(
      attempt,
      project,
      state.configured && state.index === "synced" ? "configured" : "needs_attention",
      state,
      state.index === "synced"
        ? "Memory is connected. Conversational saving and recall still need verification."
        : "Memory needs review in settings before setup can continue. No earlier work was retried.",
    )
  }

  private result(
    attempt: Attempt,
    project: string,
    status: "choice" | "configured" | "cancelled" | "needs_attention",
    state: Snapshot,
    detail?: string,
  ) {
    return {
      action: "setup" as const,
      project,
      attempt: attempt.id,
      status,
      configured: state.configured,
      root: state.root,
      index: state.index,
      capture: state.capture,
      ...(detail ? { detail } : {}),
    }
  }
}
