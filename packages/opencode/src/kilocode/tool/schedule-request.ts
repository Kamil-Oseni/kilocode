import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type * as Tool from "@/tool/tool"

const Result = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})
const Record = Schema.Struct({ version: Schema.Literal(1), signature: Schema.String, result: Schema.optional(Result) })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

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

/** A pending receipt is uncertain; it never grants permission to repeat creation. */
export function request(
  storage: Storage.Interface,
  ctx: Pick<Tool.Context, "sessionID" | "messageID" | "callID">,
  params: object,
  operation: Effect.Effect<Tool.ExecuteResult>,
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
          title: "Routine request needs review",
          output:
            saved && saved.signature !== signature
              ? "This tool call previously used different instructions. Review the earlier attempt in Routines before creating another routine."
              : "The earlier attempt is still running or its result could not be confirmed. Review Routines before retrying; do not create a replacement routine.",
          metadata: { requestStatus: "unresolved" },
        }
      }
      const result = yield* restore(operation)
      yield* storage.replace(key, { version: 1, signature, result }).pipe(Effect.orDie)
      return result
    }),
  )
}
