import { Cause, Effect, Exit } from "effect"
import {
  finalizeTransaction,
  prepareTransaction,
  publishTransaction,
  restoreTransaction,
  type TransactionEntry,
} from "@kilocode/sandbox"
import type { Storage } from "@/storage/storage"
import { Conflict, journals } from "./mutation-journal"

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
            const artifact = yield* prepareTransaction(state.entries[index]!, item.data)
            state.entries[index] = { ...state.entries[index]!, artifact }
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
      return yield* advance("done", state.entries.length)
    }),
  )
}
