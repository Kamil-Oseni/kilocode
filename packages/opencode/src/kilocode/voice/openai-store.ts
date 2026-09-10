import { Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { RayaVoiceBindingTable as Table } from "@opencode-ai/core/kilocode/voice.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import { OpenAIBinding, OpenAICall, OpenAICallInput, OpenAIImage, VoiceID, VoiceKey } from "./openai-protocol"
import { OpenAIUsage } from "./openai-usage"

const Payload = Schema.Struct({
  binding: OpenAIBinding,
  owner: VoiceID,
  hash: VoiceKey,
  requestID: VoiceID,
  calls: Schema.Record(Schema.String, Schema.Struct({ input: OpenAICallInput, receipt: OpenAICall })),
  images: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ receipt: OpenAIImage, data: Schema.String }))),
  usage: Schema.optional(Schema.Record(Schema.String, OpenAIUsage)),
})
export type Stored = {
  binding: typeof OpenAIBinding.Type
  owner: string
  hash: string
  requestID: string
  calls: Record<string, { input: typeof OpenAICallInput.Type; receipt: typeof OpenAICall.Type }>
  images?: Record<string, { receipt: typeof OpenAIImage.Type; data: string }>
  usage?: Record<string, typeof OpenAIUsage.Type>
}

export class BindingError extends Schema.TaggedErrorClass<BindingError>()("VoiceBindingError", {
  code: Schema.Literals(["missing", "conflict"]),
  message: Schema.String,
}) {}

const missing = () => Effect.fail(new BindingError({ code: "missing", message: "Voice binding not found." }))
const conflict = () =>
  Effect.fail(new BindingError({ code: "conflict", message: "Retained voice binding is invalid." }))
const key = (id: string) => ["raya_openai_voice", id]

/** SQL owns new writes. Legacy JSON is consumed once, never used as a fallback for an existing row. */
export function make(database: Database.Interface, storage: Storage.Interface) {
  const db = database.db
  const row = (id: string) => db.select().from(Table).where(eq(Table.id, id)).get().pipe(Effect.orDie)
  const parent = (id: string) =>
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionID.make(id)))
      .get()
      .pipe(Effect.orDie)
  const remove = (id: string) => storage.remove(key(id)).pipe(Effect.orDie)
  const validate = (value: unknown, id: string, session?: string): Effect.Effect<Stored, BindingError> =>
    Schema.is(Payload)(value) && value.binding.id === id && (!session || value.binding.parentSessionID === session)
      ? Effect.succeed(value)
      : conflict()
  const read = (id: string) =>
    Effect.gen(function* () {
      const retained = yield* row(id)
      if (retained) {
        const value = yield* validate(retained.data, id, retained.session_id)
        yield* remove(id)
        return value
      }
      const legacy = yield* storage
        .read<unknown>(key(id))
        .pipe(Effect.catch((error) => (error._tag === "NotFoundError" ? missing() : Effect.die(error))))
      const value = yield* validate(legacy, id)
      if (!(yield* parent(value.binding.parentSessionID))) {
        yield* remove(id)
        return yield* missing()
      }
      yield* db
        .insert(Table)
        .values({ id, session_id: value.binding.parentSessionID, data: value })
        .onConflictDoNothing()
        .run()
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // A concurrent parent deletion must not leave a resurrectable legacy record.
              if (yield* parent(value.binding.parentSessionID)) return yield* Effect.die(error)
              yield* remove(id)
              return yield* missing()
            }),
          ),
        )
      const migrated = yield* row(id)
      yield* remove(id)
      if (!migrated) return yield* missing()
      return yield* validate(migrated.data, id, migrated.session_id)
    })
  const create = (value: Stored) =>
    Effect.gen(function* () {
      // Migrate an earlier runtime's admission before trying to create a fresh owner/generation.
      const existing = yield* read(value.binding.id).pipe(
        Effect.catchTag("VoiceBindingError", (error) =>
          error.code === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      )
      if (existing) return false
      const rows = yield* db
        .insert(Table)
        .values({ id: value.binding.id, session_id: value.binding.parentSessionID, data: value })
        .onConflictDoNothing()
        .returning({ id: Table.id })
        .pipe(Effect.orDie)
      return rows.length === 1
    })
  const replace = (value: Stored) =>
    Effect.gen(function* () {
      const rows = yield* db
        .update(Table)
        .set({ data: value })
        .where(and(eq(Table.id, value.binding.id), eq(Table.session_id, value.binding.parentSessionID)))
        .returning({ id: Table.id })
        .pipe(Effect.orDie)
      if (rows.length !== 1) return yield* missing()
      return undefined
    })
  return { read, create, replace }
}
