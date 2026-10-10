import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { MessageTable, PartTable } from "../session/sql"
import { Committed } from "@opencode-ai/schema/kilocode/result-notice"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { digest } from "./evidence-digest"

const diffs = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(FileDiff.Info)))
const names = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(Schema.String)))
const hash = (value: unknown) => digest({ tool: "result-notice-projection", state: value })

/** The event replays data only; its original local receipt commit is not replayed. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* events.project(Committed, (event) =>
      Effect.gen(function* () {
        const info = event.data.info
        const part = event.data.part
        if (
          info.sessionID !== event.data.sessionID ||
          part.sessionID !== info.sessionID ||
          part.messageID !== info.id ||
          part.synthetic !== true ||
          part.ignored === true ||
          !Number.isSafeInteger(info.time.created) ||
          info.time.created < 0 ||
          !Number.isSafeInteger(event.data.time) ||
          event.data.time !== info.time.created ||
          Buffer.byteLength(part.text, "utf8") > 64 * 1024
        )
          throw new Error("Result notice projection differs")
        const { id, sessionID, ...data } = info
        const message = {
          ...data,
          summary: data.summary ? { ...data.summary, diffs: diffs(data.summary.diffs) } : undefined,
          editorContext: data.editorContext
            ? {
                ...data.editorContext,
                visibleFiles: data.editorContext.visibleFiles ? names(data.editorContext.visibleFiles) : undefined,
                openTabs: data.editorContext.openTabs ? names(data.editorContext.openTabs) : undefined,
              }
            : undefined,
        }
        const { id: pid, sessionID: sid, messageID, ...text } = part
        const prior = yield* database.db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, id))
          .get()
          .pipe(Effect.orDie)
        const previous = yield* database.db
          .select()
          .from(PartTable)
          .where(eq(PartTable.id, pid))
          .get()
          .pipe(Effect.orDie)
        if (
          (prior &&
            (prior.session_id !== sessionID ||
              prior.time_created !== info.time.created ||
              hash(prior.data) !== hash(message))) ||
          (previous &&
            (previous.session_id !== sid ||
              previous.message_id !== messageID ||
              previous.time_created !== event.data.time ||
              hash(previous.data) !== hash(text)))
        )
          throw new Error("Result notice projection identity already belongs to different data")
        if (!prior)
          yield* database.db
            .insert(MessageTable)
            .values({ id, session_id: sessionID, time_created: info.time.created, data: message })
            .run()
            .pipe(Effect.orDie)
        if (!previous)
          yield* database.db
            .insert(PartTable)
            .values({ id: pid, session_id: sid, message_id: messageID, time_created: event.data.time, data: text })
            .run()
            .pipe(Effect.orDie)
      }),
    )
  }),
)
