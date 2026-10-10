import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Service } from "@opencode-ai/core/kilocode/background-outcome"
import type { Info } from "@opencode-ai/core/background-job"
import type { Interface, Receipt } from "@opencode-ai/core/kilocode/background-outcome"
import { BackgroundOutcome as Table } from "@opencode-ai/core/kilocode/background-outcome.sql"

const cap = 256 * 1024
const name = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 256 && !value.includes("\0"))
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const origin = z
  .object({ sessionID: name, messageID: name, callID: name, childSessionID: name, childMessageID: name })
  .strict()
const identity = z
  .object({ id: name, revision: name, type: name, started_at: time, origins: z.array(origin).min(1).max(1024) })
  .strict()
const terminal = z
  .object({
    id: name,
    revision: name,
    type: name,
    started_at: time,
    origins: z.array(origin).min(1).max(1024),
    status: z.enum(["completed", "error", "cancelled"]),
    completed_at: time,
    title: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.completed_at >= value.started_at)

function fail(message: string): never {
  throw new Error(`Background outcome ${message}`)
}
function encode(value: unknown) {
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) > cap) fail("evidence exceeds bound")
  return { text, sha: createHash("sha256").update(text).digest("hex") }
}
function original(info: Info) {
  return identity.parse({
    id: info.id,
    revision: info.revision,
    type: info.type,
    started_at: info.started_at,
    origins: info.origins,
  })
}

/** Scoped live SQL writers cannot be reconstructed from serializable receipts.
 * Their producer identity is supplied only by the actual BackgroundJob integration.
 * This module neither starts work nor infers that a terminal result has joined. */
export const make = Effect.fn("BackgroundOutcome.make")(function* (database: Database.Interface) {
  const state = {
    open: true,
    writers: new WeakMap<object, { identity: z.infer<typeof identity>; text: string; sha: string }>(),
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      state.open = false
    }),
  )
  const where = (input: { id: string; revision: string }) =>
    and(eq(Table.id, input.id), eq(Table.revision, input.revision))
  const read = Effect.fn("BackgroundOutcome.read")(function* (
    db: Pick<Database.Interface["db"], "select">,
    input: { id: string; revision: string },
  ) {
    name.parse(input.id)
    name.parse(input.revision)
    const sizes = yield* db
      .select({
        identity: sql<number>`length(CAST(${Table.identity} AS BLOB))`,
        terminal: sql<number | null>`length(CAST(${Table.terminal} AS BLOB))`,
        identitySHA: sql<number>`length(CAST(${Table.identitySHA} AS BLOB))`,
        terminalSHA: sql<number | null>`length(CAST(${Table.terminalSHA} AS BLOB))`,
        phase: sql<number>`length(CAST(${Table.phase} AS BLOB))`,
      })
      .from(Table)
      .where(where(input))
      .limit(1)
      .all()
    if (!sizes.length) return undefined
    if (
      !Number.isSafeInteger(sizes[0].identity) ||
      sizes[0].identity < 1 ||
      sizes[0].identity > cap ||
      sizes[0].identitySHA !== 64 ||
      (sizes[0].terminalSHA !== null && sizes[0].terminalSHA !== 64) ||
      !Number.isSafeInteger(sizes[0].phase) ||
      sizes[0].phase < 1 ||
      sizes[0].phase > 8 ||
      (sizes[0].terminal !== null &&
        (!Number.isSafeInteger(sizes[0].terminal) || sizes[0].terminal < 1 || sizes[0].terminal > cap))
    )
      fail("stored evidence exceeds bound")
    const rows = yield* db.select().from(Table).where(where(input)).limit(1).all()
    const row = rows[0]
    if (!row) fail("selected row disappeared")
    const selected = identity.parse(JSON.parse(row.identity))
    const encoded = encode(selected)
    if (
      selected.id !== input.id ||
      selected.revision !== input.revision ||
      encoded.text !== row.identity ||
      encoded.sha !== row.identitySHA
    )
      fail("original identity changed")
    if (row.phase === "admitted") {
      if (row.terminal !== null || row.terminalSHA !== null) fail("admission has unknown result")
      return { version: 1, phase: row.phase, identity: selected, identitySHA: encoded.sha } satisfies Receipt
    }
    if ((row.phase !== "terminal" && row.phase !== "joined") || row.terminal === null || row.terminalSHA === null)
      fail("stored phase is invalid")
    const outcome = terminal.parse(JSON.parse(row.terminal))
    const body = encode(outcome)
    if (body.text !== row.terminal || body.sha !== row.terminalSHA || encode(original(outcome)).sha !== encoded.sha)
      fail("terminal evidence changed")
    return {
      version: 1,
      phase: row.phase,
      identity: selected,
      identitySHA: encoded.sha,
      terminal: outcome,
      terminalSHA: body.sha,
    } satisfies Receipt
  })
  const held = (token: object) => {
    const value = state.writers.get(token)
    if (!state.open || !value) fail("original live writer is unavailable")
    return value
  }
  const advance = (token: object, info: Info, joined: boolean) =>
    Effect.gen(function* () {
      const writer = held(token)
      const outcome = terminal.parse(info)
      const body = encode(outcome)
      if (encode(original(outcome)).sha !== writer.sha) fail("producer generation differs")
      yield* database.db.transaction(
        (tx) =>
          Effect.gen(function* () {
            held(token)
            const row = yield* read(tx, writer.identity)
            if (!row || row.identitySHA !== writer.sha) fail("original admission differs")
            if (row.phase !== "admitted" && row.terminalSHA !== body.sha) fail("original terminal differs")
            if (joined && row.phase === "admitted") fail("original terminal has not been observed")
            if ((joined && row.phase === "joined") || (!joined && row.phase !== "admitted")) return
            const updated = yield* tx
              .update(Table)
              .set({ phase: joined ? "joined" : "terminal", terminal: body.text, terminalSHA: body.sha })
              .where(and(where(writer.identity), eq(Table.phase, row.phase), eq(Table.identitySHA, writer.sha)))
              .returning()
              .all()
            if (updated.length !== 1) fail("original transition changed")
            held(token)
          }),
        { behavior: "immediate" },
      )
    })
  const api: Interface = {
    admit: (info) =>
      Effect.gen(function* () {
        if (!state.open || info.status !== "running") fail("original admission is unavailable")
        const selected = original(info)
        const encoded = encode(selected)
        const token = Object.freeze({})
        yield* database.db.transaction(
          (tx) =>
            Effect.gen(function* () {
              if (yield* read(tx, selected)) fail("original generation is already retained")
              yield* tx
                .insert(Table)
                .values({
                  id: selected.id,
                  revision: selected.revision,
                  identity: encoded.text,
                  identitySHA: encoded.sha,
                  phase: "admitted",
                })
                .run()
              if (!state.open) fail("writer scope closed during admission")
            }),
          { behavior: "immediate" },
        )
        if (!state.open) fail("writer scope closed after admission")
        state.writers.set(token, { identity: selected, ...encoded })
        return token
      }),
    observe: (token, info) => advance(token, info, false),
    joined: (token, info) => advance(token, info, true),
    get: (input) => database.db.transaction((tx) => read(tx, input), { behavior: "deferred" }),
  }
  return api
})

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      return yield* make(yield* Database.Service)
    }),
  ),
  deps: [Database.node],
})
