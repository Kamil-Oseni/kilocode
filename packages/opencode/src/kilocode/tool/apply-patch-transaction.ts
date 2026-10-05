import { Cause, Effect, Exit } from "effect"
import {
  finalizeTransaction,
  inspectTransaction,
  prepareTransaction,
  publishTransaction,
  restoreTransaction,
  type TransactionEntry,
} from "@kilocode/sandbox"
import type { Storage } from "@/storage/storage"
import { Conflict, journals, Outcome } from "./mutation-journal"
import { PlanPublication } from "../plan-publication"

export interface Item {
  readonly entry: TransactionEntry
  readonly data?: Uint8Array
}

export interface Plan {
  readonly invocation: string
  readonly digest: string
  readonly workspace: string
  readonly items: ReadonlyArray<Item>
}

export function transact(storage: Pick<Storage.Interface, "create" | "read" | "remove" | "list">, input: Plan) {
  return PlanPublication.run(
    input.items.flatMap((item) => [
      item.entry.target,
      ...(item.entry.stage ? [item.entry.stage] : []),
      ...(item.entry.hold ? [item.entry.hold] : []),
    ]),
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const journal = journals(storage)
        const admitted = yield* journal.admit({
          invocation: input.invocation,
          digest: input.digest,
          workspace: input.workspace,
          entries: input.items.map((item) => item.entry),
        })
        if (!admitted.owned)
          return yield* new Conflict({
            message: `Mutation ${input.invocation} is retained at ${admitted.outcome.phase}; recover it before retrying.`,
          })
        const state = { outcome: admitted.outcome, entries: input.items.map((item) => item.entry) }
        const advance = (phase: Parameters<typeof journal.advance>[1]["phase"], cursor: number) =>
          journal
            .advance(input.invocation, {
              token: admitted.token,
              revision: state.outcome.revision,
              phase,
              cursor,
              entries: state.entries,
            })
            .pipe(Effect.tap((outcome) => Effect.sync(() => (state.outcome = outcome))))

        const apply = Effect.gen(function* () {
          for (const [index, item] of input.items.entries()) {
            if (item.entry.kind !== "remove") {
              if (!item.data)
                return yield* new Conflict({ message: `Mutation bytes are missing for ${item.entry.target}.` })
              yield* PlanPublication.limit(item.data.byteLength)
              yield* PlanPublication.check
              const artifact = yield* prepareTransaction(state.entries[index], item.data)
              state.entries[index] = { ...state.entries[index], artifact }
            }
            yield* advance("staging", index + 1)
          }
          yield* advance("prepared", state.entries.length)
          yield* advance("committing", 0)
          for (const [index, entry] of state.entries.entries()) {
            yield* PlanPublication.check
            yield* publishTransaction(entry)
            yield* advance("committing", index + 1)
          }
          yield* advance("committed", state.entries.length)
          return undefined
        })

        const result = yield* Effect.exit(restore(apply))
        if (Exit.isFailure(result)) {
          const reason = Cause.pretty(result.cause)
          const failures: unknown[] = [Cause.squash(result.cause)]
          const attempt = <A, E, R>(work: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const settled = yield* Effect.exit(work)
              if (Exit.isSuccess(settled)) return true
              failures.push(Cause.squash(settled.cause))
              return false
            })
          const conflict = () =>
            attempt(
              journal.advance(input.invocation, {
                token: admitted.token,
                revision: state.outcome.revision,
                phase: "conflict",
                cursor: state.outcome.cursor,
                entries: state.entries,
                reason: [reason, ...failures.slice(1).map(String)].join("\n"),
              }),
            )
          if (state.outcome.phase === "committed" || state.outcome.phase === "cleaning") {
            yield* conflict()
            if (failures.length > 1)
              return yield* Effect.die(new AggregateError(failures, "Mutation and conflict retention failed"))
            return yield* Effect.failCause(result.cause)
          }
          const ready = yield* attempt(advance("rolling_back", 0))
          for (const [index, entry] of state.entries.toReversed().entries()) {
            const restored = yield* attempt(PlanPublication.check.pipe(Effect.andThen(restoreTransaction(entry))))
            if (ready && restored) yield* attempt(advance("rolling_back", index + 1))
          }
          // Preserve rollback artifacts when any original restoration or journal update is uncertain.
          if (
            failures.length === 1 &&
            (yield* attempt(advance("rolled_back", state.entries.length))) &&
            (yield* attempt(advance("cleaning", 0)))
          ) {
            for (const [index, entry] of state.entries.entries()) {
              const cleaned = yield* attempt(
                PlanPublication.check.pipe(Effect.andThen(finalizeTransaction(entry, false))),
              )
              if (cleaned) yield* attempt(advance("cleaning", index + 1))
            }
            if (failures.length === 1 && (yield* attempt(advance("releasing", state.entries.length))))
              yield* attempt(advance("done", state.entries.length))
          }
          if (failures.length > 1) {
            yield* conflict()
            return yield* Effect.die(new AggregateError(failures, "Mutation and original rollback cleanup failed"))
          }
          return yield* Effect.failCause(result.cause)
        }

        yield* advance("cleaning", 0)
        const failures: unknown[] = []
        for (const [index, entry] of state.entries.entries()) {
          const cleaned = yield* Effect.exit(
            restore(PlanPublication.check.pipe(Effect.andThen(finalizeTransaction(entry, true)))),
          )
          if (Exit.isFailure(cleaned)) {
            failures.push(Cause.squash(cleaned.cause))
            continue
          }
          if (!failures.length) {
            const recorded = yield* Effect.exit(advance("cleaning", index + 1))
            if (Exit.isFailure(recorded)) failures.push(Cause.squash(recorded.cause))
          }
        }
        if (failures.length) {
          const retained = yield* Effect.exit(
            journal.advance(input.invocation, {
              token: admitted.token,
              revision: state.outcome.revision,
              phase: "conflict",
              cursor: state.outcome.cursor,
              entries: state.entries,
              reason: failures.map(String).join("\n"),
            }),
          )
          if (Exit.isFailure(retained)) failures.push(Cause.squash(retained.cause))
          return yield* Effect.die(new AggregateError(failures, "Mutation original cleanup failed"))
        }
        yield* advance("releasing", state.entries.length)
        return yield* advance("done", state.entries.length)
      }),
    ),
  )
}

export function recover(
  storage: Pick<Storage.Interface, "create" | "read" | "remove" | "list">,
  id: string,
  authorize?: (outcome: typeof Outcome.Type) => Effect.Effect<boolean>,
) {
  return Effect.gen(function* () {
    const original = yield* journals(storage).get(id)
    if (!original) return undefined
    const files =
      original?.entries.flatMap((entry) => [
        entry.target,
        ...(entry.stage ? [entry.stage] : []),
        ...(entry.hold ? [entry.hold] : []),
      ]) ?? []
    const retained = original.entries.flatMap((entry) => [
      ...[entry.review, entry.artifact].flatMap((proof) =>
        proof ? [{ file: entry.target, ...proof.identity, sha256: proof.sha256 }] : [],
      ),
      ...(entry.stage && entry.artifact
        ? [{ file: entry.stage, ...entry.artifact.identity, sha256: entry.artifact.sha256 }]
        : []),
      ...(entry.hold && entry.review
        ? [{ file: entry.hold, ...entry.review.identity, sha256: entry.review.sha256 }]
        : []),
    ])
    return yield* PlanPublication.run(files, resume(storage, id, files, authorize), undefined, retained)
  })
}

function resume(
  storage: Pick<Storage.Interface, "create" | "read" | "remove" | "list">,
  id: string,
  files: readonly string[],
  authorize?: (outcome: typeof Outcome.Type) => Effect.Effect<boolean>,
) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const journal = journals(storage)
      const claimed = yield* journal.recover(id, authorize)
      if (!claimed.owned) return claimed.outcome
      if (
        claimed.outcome.entries.some((entry) =>
          [entry.target, entry.stage, entry.hold].some((file) => file !== undefined && !files.includes(file)),
        )
      )
        return yield* new Conflict({ message: "Mutation recovery paths changed after original admission." })
      const state = { outcome: claimed.outcome, entries: [...claimed.outcome.entries] }
      const advance = (phase: Parameters<typeof journal.advance>[1]["phase"], cursor: number) =>
        journal
          .advance(id, {
            token: claimed.token,
            revision: state.outcome.revision,
            phase,
            cursor,
            entries: state.entries,
          })
          .pipe(Effect.tap((outcome) => Effect.sync(() => (state.outcome = outcome))))
      const work = Effect.gen(function* () {
        if (state.outcome.phase === "releasing") return yield* advance("done", state.entries.length)
        if (state.outcome.phase === "staging") {
          for (const [index, entry] of state.entries.entries()) {
            if (entry.kind === "remove" || entry.artifact) continue
            const artifact = yield* inspectTransaction(entry)
            if (artifact) state.entries[index] = { ...entry, artifact }
          }
          yield* advance("staging", state.outcome.cursor)
        }
        const committed = state.outcome.decision === "commit" || state.outcome.phase === "committed"
        if (committed) {
          if (state.outcome.phase === "committed") yield* advance("cleaning", 0)
          for (const [index, entry] of state.entries.entries()) {
            if (index < state.outcome.cursor) continue
            yield* PlanPublication.check
            yield* finalizeTransaction(entry, true)
            yield* advance("cleaning", index + 1)
          }
          yield* advance("releasing", state.entries.length)
          return yield* advance("done", state.entries.length)
        }
        if (state.outcome.phase === "cleaning" && state.outcome.decision === "rollback") {
          for (const [index, entry] of state.entries.entries()) {
            if (index < state.outcome.cursor) continue
            yield* PlanPublication.check
            yield* finalizeTransaction(entry, false)
            yield* advance("cleaning", index + 1)
          }
          yield* advance("releasing", state.entries.length)
          return yield* advance("done", state.entries.length)
        }
        if (state.outcome.phase !== "rolling_back" && state.outcome.phase !== "rolled_back")
          yield* advance("rolling_back", 0)
        if (state.outcome.phase === "rolling_back") {
          for (const [index, entry] of state.entries.toReversed().entries()) {
            if (index < state.outcome.cursor) continue
            yield* PlanPublication.check
            yield* restoreTransaction(entry)
            yield* advance("rolling_back", index + 1)
          }
          yield* advance("rolled_back", state.entries.length)
        }
        yield* advance("cleaning", 0)
        for (const [index, entry] of state.entries.entries()) {
          yield* PlanPublication.check
          yield* finalizeTransaction(entry, false)
          yield* advance("cleaning", index + 1)
        }
        yield* advance("releasing", state.entries.length)
        return yield* advance("done", state.entries.length)
      })
      const result = yield* Effect.exit(work)
      if (Exit.isSuccess(result)) return result.value
      if (state.outcome.phase !== "conflict") {
        const retained = yield* Effect.exit(
          journal.advance(id, {
            token: claimed.token,
            revision: state.outcome.revision,
            phase: "conflict",
            cursor: state.outcome.cursor,
            entries: state.entries,
            reason: Cause.pretty(result.cause),
          }),
        )
        if (Exit.isFailure(retained))
          return yield* Effect.die(
            new AggregateError(
              [Cause.squash(result.cause), Cause.squash(retained.cause)],
              "Mutation recovery and conflict retention failed",
            ),
          )
      }
      return yield* Effect.failCause(result.cause)
    }),
  )
}

export function recoverPending(storage: Pick<Storage.Interface, "create" | "read" | "remove" | "list">) {
  return Effect.gen(function* () {
    const journal = journals(storage)
    const pending = yield* journal.pending()
    const outcomes: (typeof Outcome.Type)[] = []
    const issues = [...pending.issues]
    for (const outcome of pending.outcomes) {
      const result = yield* Effect.exit(recover(storage, outcome.invocation))
      if (Exit.isSuccess(result) && result.value) {
        outcomes.push(result.value)
        continue
      }
      const current = yield* journal.get(outcome.invocation)
      if (current) outcomes.push(current)
      if (Exit.isFailure(result)) issues.push({ key: outcome.invocation, reason: Cause.pretty(result.cause) })
    }
    return { outcomes, issues, truncated: pending.truncated }
  })
}
