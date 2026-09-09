import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Storage } from "@/storage/storage"
import { Storage as Store } from "@/storage/storage"
import { SessionID, MessageID } from "@/session/schema"
import type { Outcome } from "./repair"
import type { Completion } from "./completion"
import * as Source from "./snapshot"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const Assessment = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unknown"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("snapshot-input"),
    digest: Hash,
    head: Schema.String,
    checks: Schema.Array(Schema.String),
    contract: Schema.Literal("Captured source input; execution checkout is writable and dependencies are not sealed."),
  }),
]).annotate({ identifier: "Raya.SelfHealSourceAssessment" })
const Identity = Schema.Struct({ createdAt: Time, objective: Schema.String, criteria: Schema.String })
const Input = Schema.Struct({
  action: Schema.optional(Schema.Literal("run")),
  command: Schema.String,
  setup: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Number),
})
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  itemID: Schema.String,
  attemptID: Schema.String,
  sessionID: SessionID,
  messageID: MessageID,
  callID: Schema.String,
  goal: Identity,
  input: Input,
  snapshot: Source.Snapshot,
  directory: Schema.String,
  startedAt: Time,
  finishedAt: Time,
  exit: Schema.Number,
})
type Identity = typeof Identity.Type
type Input = typeof Input.Type
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const identity = (goal: { createdAt: number; objective: string; criteria?: unknown }): Identity => ({
  createdAt: goal.createdAt,
  objective: goal.objective,
  criteria: hash(JSON.stringify(goal.criteria ?? null)),
})
const equal = (one: unknown, two: unknown) =>
  digest({ tool: "verification", state: one }) === digest({ tool: "verification", state: two })

export function verification(
  storage: Pick<Storage.Interface, "read" | "create">,
  root = path.join(Global.Path.data, "raya", "verification"),
) {
  const key = (session: string, message: string, call: string) => [
    "raya",
    "self-heal",
    "verification",
    hash(JSON.stringify([session, message, call])),
  ]
  const get = Effect.fn(function* (session: string, message: string, call: string) {
    return yield* storage.read<unknown>([...key(session, message, call), "result"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
      Effect.catchIf(Store.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  })
  const status = Effect.fn(function* (session: string, message: string, call: string) {
    const read = (stage: string) =>
      storage.read<unknown>([...key(session, message, call), stage]).pipe(
        Effect.catchIf(Store.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
    const intent = yield* read("intent")
    if (!intent) return undefined
    const result = yield* get(session, message, call)
    return {
      intent,
      snapshot: yield* read("snapshot"),
      preparation: yield* read("preparation"),
      dispatch: yield* read("dispatch"),
      terminal: yield* read("terminal"),
      result: result
        ? {
            id: result.id,
            snapshot: result.snapshot.digest,
            directory: result.directory,
            exit: result.exit,
            finishedAt: result.finishedAt,
          }
        : undefined,
      guidance: result
        ? "Successful check receipt retained; goal, release and installation are separate outcomes."
        : "No successful check receipt is retained. Missing terminal acknowledgement is unknown; inspect before starting a new invocation. This inspection never replays work.",
    }
  })
  const run = Effect.fn(function* (input: {
    outcome: typeof Outcome.Type
    goal: Identity
    sessionID: SessionID
    messageID: MessageID
    callID: string
    input: Input
    current: () => Effect.Effect<void>
    execute: (command: string, directory: string) => Effect.Effect<{ output: string; metadata: { exit?: unknown } }>
  }) {
    if (!input.outcome.worktree || input.outcome.sessionID !== input.sessionID)
      throw new Error("Verification needs an owned repair checkout")
    const id = randomUUID()
    const startedAt = Date.now()
    if (
      !(yield* storage
        .create([...key(input.sessionID, input.messageID, input.callID), "intent"], {
          id,
          itemID: input.outcome.itemID,
          attemptID: input.outcome.id,
          sessionID: input.sessionID,
          messageID: input.messageID,
          callID: input.callID,
          input: input.input,
          at: startedAt,
        })
        .pipe(Effect.orDie))
    )
      throw new Error(
        "This verification invocation already has retained intent; inspect it instead of replaying the command",
      )
    return yield* Effect.gen(function* () {
      const stage = (name: string, data: unknown) =>
        storage
          .create([...key(input.sessionID, input.messageID, input.callID), name], data)
          .pipe(Effect.orDie, Effect.asVoid)
      yield* input.current()
      const snapshot = yield* Effect.promise(() =>
        Source.capture(input.outcome.worktree!.directory, root, input.outcome.worktree),
      )
      const directory = yield* Effect.promise(() => Source.materialize(root, snapshot))
      yield* stage("snapshot", { digest: snapshot.digest, head: snapshot.head, directory, at: Date.now() })
      const cwd = path.resolve(directory, input.input.workdir ?? ".")
      const relative = path.relative(directory, cwd)
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        throw new Error("Verification workdir must stay in its private snapshot")
      yield* input.current()
      if (input.input.setup) {
        yield* stage("preparation", { at: Date.now(), command: input.input.setup })
        const setup = yield* input.execute(input.input.setup, directory)
        if (setup.metadata.exit !== 0)
          throw new Error(`Verification dependency preparation failed; no check receipt was issued.\n${setup.output}`)
        yield* Effect.promise(() => Source.unchanged(directory, snapshot))
      }
      yield* input.current()
      const before = yield* Effect.promise(() =>
        Source.capture(input.outcome.worktree!.directory, undefined, input.outcome.worktree),
      )
      if (before.digest !== snapshot.digest) throw new Error("Repair source changed before verification dispatch")
      yield* stage("dispatch", { at: Date.now(), command: input.input.command, directory: cwd })
      const result = yield* input.execute(input.input.command, cwd)
      yield* Effect.promise(() => Source.unchanged(directory, snapshot))
      yield* input.current()
      const after = yield* Effect.promise(() =>
        Source.capture(input.outcome.worktree!.directory, undefined, input.outcome.worktree),
      )
      if (after.digest !== snapshot.digest)
        throw new Error("Repair source changed during verification; rerun against the current input")
      if (result.metadata.exit !== 0) {
        yield* stage("terminal", {
          status: "failed",
          at: Date.now(),
          exit: typeof result.metadata.exit === "number" ? result.metadata.exit : undefined,
        })
        return { output: result.output, metadata: { exit: result.metadata.exit, source: "unverified" } }
      }
      const receipt: typeof Receipt.Type = {
        version: 1,
        id,
        itemID: input.outcome.itemID,
        attemptID: input.outcome.id,
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
        goal: input.goal,
        input: input.input,
        snapshot,
        directory,
        startedAt,
        finishedAt: Date.now(),
        exit: 0,
      }
      if (
        !(yield* storage
          .create([...key(input.sessionID, input.messageID, input.callID), "result"], receipt)
          .pipe(Effect.orDie))
      )
        throw new Error("Verification result already exists; retain it for reconciliation")
      return { output: result.output, metadata: { exit: 0, verification: id, snapshot: snapshot.digest } }
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? storage
              .create([...key(input.sessionID, input.messageID, input.callID), "terminal"], {
                status: Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
                at: Date.now(),
                reason: Cause.pretty(exit.cause).slice(0, 10_000),
              })
              .pipe(Effect.orDie, Effect.asVoid)
          : Effect.void,
      ),
    )
  })
  const inspect = Effect.fn(function* (part: SessionV1.ToolPart) {
    if (part.tool !== "self_heal_verify") return undefined
    const receipt = yield* get(part.sessionID, part.messageID, part.callID)
    if (
      !receipt ||
      part.state.status !== "completed" ||
      part.state.metadata.verification !== receipt.id ||
      part.state.metadata.exit !== 0 ||
      !equal(part.state.input, receipt.input)
    )
      throw new Error("Snapshot verification evidence has no matching authoritative execution receipt")
    return receipt
  })
  const certify = Effect.fn(function* (
    outcome: typeof Outcome.Type,
    goal: Identity,
    requirements: readonly {
      passed: boolean
      evidence: readonly { sessionID?: string; messageID?: string; partID?: string; callID: string }[]
    }[],
    parts: readonly SessionV1.ToolPart[],
  ) {
    const checks: Array<typeof Receipt.Type> = []
    let missing = false
    for (const requirement of requirements.filter((row) => row.passed)) {
      const rows = yield* Effect.forEach(requirement.evidence, (ref) => {
        const matches = parts.filter(
          (part) =>
            part.sessionID === ref.sessionID &&
            part.messageID === ref.messageID &&
            part.callID === ref.callID &&
            part.id === ref.partID,
        )
        return matches.length === 1 ? inspect(matches[0]) : Effect.succeed(undefined)
      })
      const found = rows.filter((row) => row !== undefined)
      if (!found.length) missing = true
      checks.push(...found)
    }
    if (!checks.length)
      return {
        status: "unknown" as const,
        reason:
          "No source snapshot execution receipt covers this audit. Legacy and manual evidence cannot establish delivery source identity.",
      }
    if (
      checks.some(
        (row) =>
          row.itemID !== outcome.itemID ||
          row.attemptID !== outcome.id ||
          !equal(row.goal, goal) ||
          row.snapshot.digest !== checks[0].snapshot.digest,
      )
    )
      throw new Error("Verification receipts do not describe this repair goal and one consistent source input")
    if (!outcome.worktree) throw new Error("Repair checkout is unavailable")
    const current = yield* Effect.promise(() =>
      Source.capture(outcome.worktree!.directory, undefined, outcome.worktree),
    )
    if (current.digest !== checks[0].snapshot.digest)
      throw new Error("Repair source changed after the cited checks; verify the current snapshot before completion")
    if (missing)
      return {
        status: "unknown" as const,
        reason:
          "Some passed requirements lack source snapshot execution evidence; full delivery source coverage is unknown.",
      }
    return {
      status: "snapshot-input" as const,
      digest: current.digest,
      head: current.head,
      checks: [...new Set(checks.map((row) => row.id))],
      contract: "Captured source input; execution checkout is writable and dependencies are not sealed." as const,
    }
  })
  // Resolve retained receipts by the completion's exact evidence coordinates; callers cannot supply a snapshot.
  const lineage = Effect.fn(function* (completion: typeof Completion.Type) {
    const assessment = completion.verification
    if (assessment?.status !== "snapshot-input" || !assessment.checks.length)
      throw new Error("Delivery source identity is unknown; complete a snapshot-backed repair audit first")
    const checks: Array<typeof Receipt.Type> = []
    for (const requirement of completion.goal.audit.requirements.filter((row) => row.passed)) {
      const rows = yield* Effect.forEach(requirement.evidence, (ref) =>
        get(ref.sessionID, ref.messageID, ref.callID).pipe(
          Effect.map((row) => {
            if (
              row &&
              (row.sessionID !== ref.sessionID || row.messageID !== ref.messageID || row.callID !== ref.callID)
            )
              throw new Error("Retained verification receipt coordinates do not match completion evidence")
            return row
          }),
        ),
      )
      const found = rows.filter((row) => row && assessment.checks.includes(row.id))
      if (!found.length) throw new Error("Retained completion has lost its source verification coverage")
      for (const row of found) {
        if (!row) continue
        if (
          row.exit !== 0 ||
          row.itemID !== completion.itemID ||
          row.attemptID !== completion.attemptID ||
          row.sessionID !== completion.sessionID ||
          row.goal.createdAt !== completion.goal.createdAt ||
          row.goal.objective !== completion.goal.objective ||
          row.snapshot.digest !== assessment.digest ||
          row.snapshot.head !== assessment.head ||
          row.finishedAt > completion.at ||
          row.startedAt > row.finishedAt
        )
          throw new Error("Retained check does not match the completed repair source")
        checks.push(row)
      }
    }
    if (assessment.checks.some((id) => !checks.some((row) => row.id === id)))
      throw new Error("A completion check receipt is missing")
    if (
      !checks.length ||
      checks.some((row) => !equal(row.snapshot, checks[0].snapshot) || !equal(row.goal, checks[0].goal))
    )
      throw new Error("Completion checks disagree about captured source")
    return { snapshot: checks[0].snapshot, checks: assessment.checks, store: root }
  })
  return { run, inspect, certify, status, lineage }
}
