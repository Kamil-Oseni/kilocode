import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type * as Tool from "@/tool/tool"

const Result = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})
const Record = Schema.Struct({ version: Schema.Literal(1), signature: Schema.String, result: Schema.optional(Result) })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

type Review = {
  title: string
  changed: string
  pending: string
  metadata?: Record<string, unknown>
}

const routine: Review = {
  title: "Routine request needs review",
  changed:
    "This tool call previously used different instructions. Review the earlier attempt in Routines before creating another routine.",
  pending:
    "The earlier attempt is still running or its result could not be confirmed. Review Routines before retrying; do not create a replacement routine.",
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    )
  return value
}

/** Read a completed effect before asking again when a relative schedule has moved with the clock. */
export function settled(
  storage: Storage.Interface,
  ctx: Pick<Tool.Context, "sessionID" | "messageID" | "callID">,
  params: object,
) {
  if (!ctx.callID) return Effect.succeed(undefined)
  const key = ["raya", "agent-requests", hash(JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID]))]
  const signature = hash(JSON.stringify(canonical(params)))
  return Effect.gen(function* () {
    const raw = yield* storage.read(key).pipe(
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed(undefined),
      ),
      Effect.orDie,
    )
    if (raw === undefined) return undefined
    const saved = yield* Schema.decodeUnknownEffect(Record)(raw).pipe(Effect.orElseSucceed(() => undefined))
    if (saved?.signature === signature && saved.result) return saved.result
    return {
      title: routine.title,
      output: saved && saved.signature !== signature ? routine.changed : routine.pending,
      metadata: { requestStatus: "unresolved" },
    }
  })
}

/** A pending receipt is uncertain; it never grants permission to repeat creation. */
export function request(
  storage: Storage.Interface,
  ctx: Pick<Tool.Context, "sessionID" | "messageID" | "callID">,
  params: object,
  operation: Effect.Effect<Tool.ExecuteResult>,
  copy: Review = routine,
) {
  if (!ctx.callID) return operation
  const key = ["raya", "agent-requests", hash(JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID]))]
  const signature = hash(JSON.stringify(canonical(params)))
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (!(yield* storage.create(key, { version: 1, signature }).pipe(Effect.orDie))) {
        const raw = yield* storage.read(key).pipe(Effect.orDie)
        const saved = yield* Schema.decodeUnknownEffect(Record)(raw).pipe(Effect.orElseSucceed(() => undefined))
        if (saved?.signature === signature && saved.result) return saved.result
        return {
          title: copy.title,
          output: saved && saved.signature !== signature ? copy.changed : copy.pending,
          metadata: { ...copy.metadata, requestStatus: "unresolved" },
        }
      }
      const result = yield* restore(operation)
      yield* storage.replace(key, { version: 1, signature, result }).pipe(Effect.orDie)
      return result
    }),
  )
}
