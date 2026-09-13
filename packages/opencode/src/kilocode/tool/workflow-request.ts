import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type * as Tool from "@/tool/tool"

const Result = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})
const Record = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.String,
  signature: Schema.String,
  plan: Schema.Unknown,
  result: Schema.optional(Result),
})
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

export function workflow<P>(input: {
  storage: Storage.Interface
  ctx: Pick<Tool.Context, "sessionID" | "messageID" | "callID">
  kind: string
  params: object
  prepare: Effect.Effect<P, unknown>
  decode: (value: unknown) => Effect.Effect<P, unknown>
  recover: (plan: P) => Effect.Effect<Tool.ExecuteResult | undefined, unknown>
  run: (plan: P) => Effect.Effect<Tool.ExecuteResult, unknown>
}) {
  if (!input.ctx.callID) return input.prepare.pipe(Effect.flatMap(input.run))
  const owner = hash(JSON.stringify([input.ctx.sessionID, input.ctx.messageID, input.ctx.callID]))
  const key = ["raya", "agent-workflows", owner]
  const signature = hash(JSON.stringify(canonical(input.params)))
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const resume = (raw: unknown) =>
        Effect.gen(function* () {
          const saved = yield* Schema.decodeUnknownEffect(Record)(raw).pipe(Effect.orElseSucceed(() => undefined))
          if (!saved || saved.kind !== input.kind || saved.signature !== signature)
            return {
              title: "Routine change needs review",
              output:
                "This tool call already has different or unreadable saved instructions. Review Routines before making another change.",
              metadata: { requestStatus: "conflict" },
            }
          if (saved.result) return saved.result
          const prior = yield* input.decode(saved.plan).pipe(Effect.orElseSucceed(() => undefined))
          if (!prior)
            return {
              title: "Routine change needs review",
              output: "The saved recovery plan is unreadable. Review Routines before making another change.",
              metadata: { requestStatus: "unresolved" },
            }
          const recovered = yield* input.recover(prior)
          if (recovered) {
            yield* input.storage.replace(key, { ...saved, result: recovered }).pipe(Effect.orDie)
            return recovered
          }
          const result = yield* restore(input.run(prior))
          yield* input.storage.replace(key, { ...saved, result }).pipe(Effect.orDie)
          return result
        })
      const raw = yield* input.storage.read(key).pipe(
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () => Effect.succeed(undefined),
        ),
        Effect.orDie,
      )
      if (raw !== undefined) return yield* resume(raw)
      const plan = yield* input.prepare
      const fresh = { version: 1 as const, kind: input.kind, signature, plan }
      if (!(yield* input.storage.create(key, fresh).pipe(Effect.orDie))) {
        return yield* resume(yield* input.storage.read(key).pipe(Effect.orDie))
      }
      const result = yield* restore(input.run(plan))
      yield* input.storage.replace(key, { ...fresh, result }).pipe(Effect.orDie)
      return result
    }),
  )
}
