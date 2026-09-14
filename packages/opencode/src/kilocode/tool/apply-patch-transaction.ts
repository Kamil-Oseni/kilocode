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

export function transact(storage: Pick<Storage.Interface, "create" | "read" | "remove">, input: Plan) {
  return Effect.uninterruptibleMask((restore) =>
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
            const artifact = yield* prepareTransaction(state.entries[index], item.data)
            state.entries[index] = { ...state.entries[index], artifact }
          }
          yield* advance("staging", index + 1)
        }
        yield* advance("prepared", state.entries.length)
        yield* advance("committing", 0)
        for (const [index, entry] of state.entries.entries()) {
          yield* publishTransaction(entry)
          yield* advance("committing", index + 1)
        }
        yield* advance("committed", state.entries.length)
      })

      const result = yield* Effect.exit(restore(apply))
      if (Exit.isFailure(result)) {
        const reason = Cause.pretty(result.cause)
        if (state.outcome.phase === "committed" || state.outcome.phase === "cleaning") {
          yield* journal.advance(input.invocation, {
            token: admitted.token,
            revision: state.outcome.revision,
            phase: "conflict",
            cursor: state.outcome.cursor,
            entries: state.entries,
            reason,
          })
          return yield* Effect.failCause(result.cause)
        }
        yield* advance("rolling_back", 0)
        for (const [index, entry] of state.entries.toReversed().entries()) {
          yield* restoreTransaction(entry)
          yield* advance("rolling_back", index + 1)
        }
        yield* advance("rolled_back", state.entries.length)
        yield* advance("cleaning", 0)
        for (const [index, entry] of state.entries.entries()) {
          yield* finalizeTransaction(entry, false)
          yield* advance("cleaning", index + 1)
        }
        yield* advance("releasing", state.entries.length)
        yield* advance("done", state.entries.length)
        return yield* Effect.failCause(result.cause)
      }

      yield* advance("cleaning", 0)
      for (const [index, entry] of state.entries.entries()) {
        const cleaned = yield* Effect.exit(restore(finalizeTransaction(entry, true)))
        if (Exit.isFailure(cleaned)) {
          yield* journal.advance(input.invocation, {
            token: admitted.token,
            revision: state.outcome.revision,
            phase: "conflict",
            cursor: index,
            entries: state.entries,
            reason: Cause.pretty(cleaned.cause),
          })
          return yield* Effect.failCause(cleaned.cause)
        }
        yield* advance("cleaning", index + 1)
      }
      yield* advance("releasing", state.entries.length)
      return yield* advance("done", state.entries.length)
    }),
  )
}

export function recover(
  storage: Pick<Storage.Interface, "create" | "read" | "remove">,
  id: string,
  authorize?: (outcome: typeof Outcome.Type) => Effect.Effect<boolean>,
) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const journal = journals(storage)
      const claimed = yield* journal.recover(id, authorize)
      if (!claimed.owned) return claimed.outcome
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
            yield* finalizeTransaction(entry, true)
            yield* advance("cleaning", index + 1)
          }
          yield* advance("releasing", state.entries.length)
          return yield* advance("done", state.entries.length)
        }
        if (state.outcome.phase === "cleaning" && state.outcome.decision === "rollback") {
          for (const [index, entry] of state.entries.entries()) {
            if (index < state.outcome.cursor) continue
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
            yield* restoreTransaction(entry)
            yield* advance("rolling_back", index + 1)
          }
          yield* advance("rolled_back", state.entries.length)
        }
        yield* advance("cleaning", 0)
        for (const [index, entry] of state.entries.entries()) {
          yield* finalizeTransaction(entry, false)
          yield* advance("cleaning", index + 1)
        }
        yield* advance("releasing", state.entries.length)
        return yield* advance("done", state.entries.length)
      })
      const result = yield* Effect.exit(work)
      if (Exit.isSuccess(result)) return result.value
      if (state.outcome.phase !== "conflict")
        yield* journal.advance(id, {
          token: claimed.token,
          revision: state.outcome.revision,
          phase: "conflict",
          cursor: state.outcome.cursor,
          entries: state.entries,
          reason: Cause.pretty(result.cause),
        })
      return yield* Effect.failCause(result.cause)
    }),
  )
}
