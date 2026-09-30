import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineArchiveTable as Archive } from "@opencode-ai/core/kilocode/archive.sql"
import {
  RayaRoutineConversationTable as Conversation,
  RayaRoutineCursorTable as Cursor,
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOccurrenceTable as Occurrence,
  RayaRoutineOrganizationMemberTable as Member,
} from "@opencode-ai/core/kilocode/routine.sql"
import { Storage } from "@/storage/storage"

// Keep initialization evidence separate from the replaceable roster. A missing
// initialized roster must never silently become a new empty worker collection.
const marker = ["raya", "agent-initialized"]

export class MissingRoster extends Error {
  constructor() {
    super(
      "Your saved worker list is missing from an initialized profile. Restore the worker list from a backup before creating or running workers.",
    )
    this.name = "RayaTask.MissingRoster"
  }
}

export const mark = (storage: Pick<Storage.Interface, "create">) => storage.create(marker, { version: 1 })

export const initialized = (storage: Pick<Storage.Interface, "read" | "list">, database?: Database.Interface) =>
  Effect.gen(function* () {
    const saved = yield* storage
      .read<unknown>(marker)
      .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (saved !== undefined) return true
    // Legacy profiles did not have a marker. Retained worker evidence is also
    // authoritative; staging plans alone can legitimately precede the roster.
    for (const prefix of ["agent-runs", "agent-memory", "agent-archive"]) {
      if ((yield* storage.list(["raya", prefix])).length) return true
    }
    const legacy = yield* storage
      .read<unknown>(["raya", "agent-archive"])
      .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (legacy !== undefined && (!Array.isArray(legacy) || legacy.length)) return true
    if (!database) return false
    const db = database.db
    const rows = yield* Effect.all([
      db.select({ id: Archive.id }).from(Archive).limit(1).get(),
      db.select({ id: Conversation.agent_id }).from(Conversation).limit(1).get(),
      db.select({ id: Cursor.agent_id }).from(Cursor).limit(1).get(),
      db.select({ id: Delegation.id }).from(Delegation).limit(1).get(),
      db.select({ id: Occurrence.id }).from(Occurrence).limit(1).get(),
      db.select({ id: Member.agent_id }).from(Member).limit(1).get(),
    ])
    return rows.some(Boolean)
  })
