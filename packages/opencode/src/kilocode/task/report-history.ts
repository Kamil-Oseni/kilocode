import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type { RayaRoutineReports } from "./projection"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const prefix = ["raya", "routine-report-index"]
const canonical = ["raya", "routine-reports"]
const Progress = Schema.Struct({
  version: Schema.Literal(1),
  last: Schema.optional(Schema.String),
  scanned: Schema.Int,
  total: Schema.Int,
  complete: Schema.Boolean,
})
const Pointer = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  reportSessionID: Schema.String,
  at: Schema.Number,
})
function stamp(at: number) {
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleBE(at)
  if (bytes[0] & 128) {
    for (const index of bytes.keys()) bytes[index] = bytes[index] ^ 255
    return bytes.toString("hex")
  }
  bytes[0] = bytes[0] ^ 128
  return bytes.toString("hex")
}
const slot = (card: RayaRoutineReports.Card) => `${stamp(card.at)}-${hash(card.id)}`

export function history<E>(
  storage: Storage.Interface,
  decode: (value: unknown) => Effect.Effect<RayaRoutineReports.Card, E>,
) {
  const read = <A, E>(key: string[], decode: (value: unknown) => Effect.Effect<A, E>) =>
    storage.readBounded<unknown>(key, 2048).pipe(
      Effect.flatMap(decode),
      Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    )
  const upsert = Effect.fn("RoutineReportHistory.upsert")(function* (card: RayaRoutineReports.Card) {
    const key = [...prefix, hash(card.reportSessionID), slot(card)]
    const prior = yield* read(key, Schema.decodeUnknownEffect(Pointer))
    if (prior?.id === card.id && prior.reportSessionID === card.reportSessionID && prior.at === card.at) return false
    yield* storage.replace(key, { version: 1, id: card.id, reportSessionID: card.reportSessionID, at: card.at })
    return true
  })
  const bootstrap = Effect.fn("RoutineReportHistory.bootstrap")(function* () {
    const key = [...prefix, "bootstrap"]
    const entries = (yield* storage.list(canonical)).toSorted((a, b) => a.at(-1)!.localeCompare(b.at(-1)!))
    if (!entries.length) return { version: 1 as const, scanned: 0, total: 0, complete: true }
    const saved = yield* read(key, Schema.decodeUnknownEffect(Progress))
    const prior = saved?.total === entries.length ? saved : undefined
    if (prior?.complete) return prior
    const remaining = entries.filter((entry) => !prior?.last || entry.at(-1)! > prior.last)
    const batch = remaining.slice(0, 50)
    for (const entry of batch)
      yield* upsert(yield* storage.readBounded<unknown>(entry, 40 * 1024).pipe(Effect.flatMap(decode)))
    const progress = {
      version: 1 as const,
      last: batch.at(-1)?.at(-1) ?? prior?.last,
      scanned: (prior?.scanned ?? 0) + batch.length,
      total: entries.length,
      complete: remaining.length <= batch.length,
    }
    yield* storage.replace(key, progress)
    return progress
  })
  const page = Effect.fn("RoutineReportHistory.page")(function* (input: {
    sessionID: string
    cursor?: string
    limit?: number
  }) {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200))
      return yield* Effect.fail(new Error("Choose a report page size between 1 and 200."))
    const owner = hash(input.sessionID)
    if (
      input.cursor &&
      (!input.cursor.startsWith(`${owner}:`) || !/^[a-f0-9]{64}:[a-f0-9]{16}-[a-f0-9]{64}$/.test(input.cursor))
    )
      return yield* Effect.fail(new Error("This report cursor does not belong to this conversation."))
    const after = input.cursor?.slice(65)
    const entries = (yield* storage.list([...prefix, owner]))
      .map((key) => key.at(-1)!)
      .filter((key) => !after || key < after)
      .toSorted()
      .reverse()
    const items: RayaRoutineReports.Card[] = []
    const limit = input.limit ?? 200
    let bytes = 0
    let scanned = 0
    let last = after
    for (const entry of entries.slice(0, 500)) {
      const pointer = yield* read([...prefix, owner, entry], Schema.decodeUnknownEffect(Pointer))
      if (!pointer || pointer.reportSessionID !== input.sessionID)
        return yield* Effect.fail(new Error("Routine report index identity changed."))
      const card = yield* storage
        .readBounded<unknown>([...canonical, hash(pointer.id)], 40 * 1024)
        .pipe(Effect.flatMap(decode))
      const valid = card.id === pointer.id && card.reportSessionID === input.sessionID && slot(card) === entry
      const size = valid ? Buffer.byteLength(JSON.stringify(card)) : 0
      if (valid && (items.length === limit || bytes + size > 1024 * 1024 - 4096)) break
      last = entry
      scanned++
      if (!valid) continue
      items.push(card)
      bytes += size
    }
    return { items, ...(scanned < entries.length && last ? { next: `${owner}:${last}` } : {}) }
  })
  return { upsert, bootstrap, page }
}
