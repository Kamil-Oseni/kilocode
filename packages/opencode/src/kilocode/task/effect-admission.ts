import { and, asc, eq, inArray, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import z from "zod"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectParticipant as Participants,
  RoutineEffectCapsule as Capsules,
  RoutineEffectMembership as Memberships,
  RoutineEffectAttempt as Attempts,
  RoutineEffectRevocation as Revocations,
} from "@opencode-ai/core/kilocode/routine-effect.sql"

// This module is inactive infrastructure: it never opens a transaction, qualifies
// a participant, activates a generation, calls transport or reconstructs ownership.
// Callers must supply the original immediate transaction from the selected profile.
// Serializable rows are NOT process/run/step capabilities. validate() creates ONLY
// a transaction-local SQL consistency witness. No returned value or successful
// transition authorizes a model/tool/native effect, participant or selected profile.
// Actual enrollment, native capability and participating writers are still absent.
// Future authenticated intent must derive purpose from the original model/tool-call
// identity; caller-selected SQL strings cannot authorize new or retried effects.
// A model step can retain up to 1024 distinct logical effect purposes; over-cap
// state refuses validation rather than dropping or reassigning original debt.
// These SQL checks cannot attest against arbitrary direct DB rollback/deletion.
// Old-binary exclusion and participation of every authority writer remain required.
type Tx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
const id = z.string().regex(/^[a-f0-9]{32}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const name = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 256 && !value.includes("\0"))
const birth = z
  .string()
  .regex(/^\d{1,20}$/)
  .refine((value) => BigInt(value) > 0n && BigInt(value) <= 18446744073709551615n)
const scope = z
  .object({
    id: hash,
    kind: z.enum(["principal", "organization", "goal", "run", "session", "delegation", "workspace", "config"]),
    principal: name,
    birth,
    generation: id,
    projection: hash,
  })
  .strict()
const participant = z
  .object({
    id,
    profile: hash,
    protocol: z.literal("raya.routine.effect.v1"),
    cohort: hash,
    pid: z.number().int().positive().max(4294967295),
    birth,
  })
  .strict()
const member = z.object({ scope: hash, generation: id }).strict()
const capsule = z
  .object({
    id,
    participant: id,
    generation: id,
    run: name,
    session: name,
    step: name,
    owner: hash,
    projection: hash,
    scopes: z.array(member).min(1).max(64),
  })
  .strict()
  .refine((value) => new Set(value.scopes.map((row) => row.scope)).size === value.scopes.length)
const attempt = z
  .object({ id, kind: z.enum(["model", "tool", "mcp", "browser", "native"]), purpose: name, digest: hash })
  .strict()
const revoke = z.object({ id, scope: hash, generation: id, projection: hash, request: hash, reason: name }).strict()

export class Refusal extends Schema.TaggedErrorClass<Refusal>()("RoutineEffect.Refusal", { message: Schema.String }) {}

function decode<T>(schema: z.ZodType<T>, value: unknown) {
  return Effect.try({
    try: () => schema.parse(value),
    catch: () => new Refusal({ message: "Bounded original effect identity required" }),
  })
}

function require(value: unknown, message: string) {
  return value ? Effect.void : Effect.fail(new Refusal({ message }))
}

/** Every method uses ONLY this supplied immediate transaction. Propagate failures
 * to its caller so the original transaction rolls back; never catch-and-commit.
 * Tokens do not survive the transaction. No native ownership is inferred. */
type State = {
  active: boolean
  brands: WeakMap<
    object,
    {
      mode: "active" | "debt"
      capsule: z.infer<typeof capsule>
      participant: z.infer<typeof participant>
      scopes: Map<string, typeof Scopes.$inferSelect>
    }
  >
}

function make(tx: Tx, state: State) {
  const records = Effect.fn("RoutineEffect.records")(function* (selected: z.infer<typeof capsule>) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const rows = yield* tx.select().from(Attempts).where(eq(Attempts.capsule, selected.id)).limit(1025).all()
    yield* require(rows.length <= 1024 &&
      new Set(rows.map((row) => row.purpose)).size === rows.length, "Unknown effect attempt roster")
    for (const row of rows) {
      yield* decode(attempt, { id: row.id, kind: row.kind, purpose: row.purpose, digest: row.digest })
      yield* require(row.generation === selected.generation &&
        row.owner === selected.owner, "Unknown effect attempt generation or owner")
      yield* require(["reserved", "started", "settled", "refused", "uncertain"].includes(
        row.state,
      ), "Unknown effect attempt state")
      yield* require(row.state === "settled"
        ? typeof row.receipt === "string" && hash.safeParse(row.receipt).success
        : row.receipt === null, "Unknown effect attempt receipt")
    }
    return rows
  })
  const inspect = Effect.fn("RoutineEffect.inspect")(function* (token: object) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const held = state.brands.get(token)
    yield* require(held, "Private transaction SQL witness required")
    const original = held!
    yield* require(original.mode === "active", "Debt-only SQL witness cannot reserve or start")
    const selected = yield* tx.select().from(Capsules).where(eq(Capsules.id, original.capsule.id)).get()
    const owner = yield* tx.select().from(Participants).where(eq(Participants.id, original.participant.id)).get()
    yield* require(selected?.state === "active" &&
      owner?.state === "qualified", "SQL effect record is inactive or revoked")
    const { scopes, ...expected } = original.capsule
    yield* require(isDeepStrictEqual(selected, { ...expected, state: "active" }), "Original effect capsule changed")
    yield* require(isDeepStrictEqual(owner, {
      ...original.participant,
      state: "qualified",
    }), "Original effect participant changed")
    const rows = yield* tx
      .select()
      .from(Memberships)
      .where(eq(Memberships.capsule, selected!.id))
      .orderBy(asc(Memberships.scope))
      .limit(65)
      .all()
    yield* require(rows.length === scopes.length &&
      rows.every(
        (row, index) => row.scope === scopes[index].scope && row.generation === scopes[index].generation,
      ), "Original effect scope membership changed")
    for (const row of rows) {
      const current = yield* tx.select().from(Scopes).where(eq(Scopes.id, row.scope)).get()
      yield* require(current?.state === "active" &&
        current.generation === row.generation, "Original effect scope revoked")
      yield* decode(scope, Object.fromEntries(Object.entries(current!).filter(([key]) => key !== "state")))
      yield* require(isDeepStrictEqual(
        original.scopes.get(row.scope),
        current,
      ), "Original effect scope projection changed")
      const pending = yield* tx
        .select({ id: Revocations.id })
        .from(Revocations)
        .where(and(eq(Revocations.scope, row.scope), eq(Revocations.generation, row.generation)))
        .get()
      yield* require(!pending, "Original effect scope has retained revocation")
    }
    yield* records(original.capsule)
    return original.capsule
  })

  const stageScope = Effect.fn("RoutineEffect.stageScope")(function* (input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(scope, input)
    const saved = yield* tx
      .insert(Scopes)
      .values({ ...value, state: "inactive" })
      .onConflictDoNothing()
      .returning()
      .get()
    yield* require(saved, "Effect scope already exists; activation cannot be inferred")
    return value
  })
  const stageParticipant = Effect.fn("RoutineEffect.stageParticipant")(function* (input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(participant, input)
    const saved = yield* tx
      .insert(Participants)
      .values({ ...value, state: "inactive" })
      .onConflictDoNothing()
      .returning()
      .get()
    yield* require(saved, "Effect participant already exists")
    return value
  })
  const stageCapsule = Effect.fn("RoutineEffect.stageCapsule")(function* (input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(capsule, input)
    const { scopes, ...record } = value
    const saved = yield* tx
      .insert(Capsules)
      .values({ ...record, state: "inactive" })
      .onConflictDoNothing()
      .returning()
      .get()
    yield* require(saved, "Original effect capsule already exists")
    yield* tx
      .insert(Memberships)
      .values(scopes.map((row) => ({ capsule: value.id, ...row })))
      .run()
    return value
  })
  const validate = Effect.fn("RoutineEffect.validate")(function* (input: unknown, owner: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(capsule, input)
    value.scopes.sort((left, right) => left.scope.localeCompare(right.scope))
    const selected = yield* decode(participant, owner)
    yield* require(value.participant === selected.id, "Original effect participant identity differs")
    const token = Object.freeze({})
    const snapshots = new Map<string, typeof Scopes.$inferSelect>()
    for (const row of value.scopes) {
      const current = yield* tx.select().from(Scopes).where(eq(Scopes.id, row.scope)).get()
      yield* require(current?.state === "active" &&
        current.generation === row.generation, "Original effect scope revoked")
      yield* decode(scope, Object.fromEntries(Object.entries(current!).filter(([key]) => key !== "state")))
      snapshots.set(row.scope, structuredClone(current!))
    }
    state.brands.set(token, {
      mode: "active",
      capsule: structuredClone(value),
      participant: structuredClone(selected),
      scopes: snapshots,
    })
    yield* inspect(token)
    return token
  })
  const reserve = Effect.fn("RoutineEffect.reserve")(function* (token: object, input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const selected = yield* inspect(token)
    const value = yield* decode(attempt, input)
    const rows = yield* records(selected)
    yield* require(rows.length < 1024, "Effect attempt roster capacity reached; original debt retained")
    const saved = yield* tx
      .insert(Attempts)
      .values({
        ...value,
        capsule: selected.id,
        generation: selected.generation,
        owner: selected.owner,
        state: "reserved",
        receipt: null,
      })
      .onConflictDoNothing()
      .returning()
      .get()
    yield* require(saved, "Original effect attempt already exists; replay refused")
    return saved!
  })
  const start = Effect.fn("RoutineEffect.start")(function* (token: object, input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const selected = yield* inspect(token)
    const value = yield* decode(attempt, input)
    const saved = yield* tx
      .update(Attempts)
      .set({ state: "started" })
      .where(
        and(
          eq(Attempts.id, value.id),
          eq(Attempts.capsule, selected.id),
          eq(Attempts.generation, selected.generation),
          eq(Attempts.owner, selected.owner),
          eq(Attempts.kind, value.kind),
          eq(Attempts.purpose, value.purpose),
          eq(Attempts.digest, value.digest),
          eq(Attempts.state, "reserved"),
        ),
      )
      .returning()
      .get()
    yield* require(saved, "Original reserved attempt changed or was already consumed")
    return saved!
  })
  const debt = Effect.fn("RoutineEffect.debt")(function* (token: object) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const held = state.brands.get(token)
    yield* require(held, "Private transaction SQL witness required")
    const current = yield* tx.select().from(Capsules).where(eq(Capsules.id, held!.capsule.id)).get()
    const owner = yield* tx.select().from(Participants).where(eq(Participants.id, held!.participant.id)).get()
    const { scopes, ...expected } = held!.capsule
    yield* require(current &&
      ["active", "revoked", "retired"].includes(current.state) &&
      owner &&
      ["qualified", "revoked", "retired"].includes(owner.state), "Original debt authority state invalid")
    yield* require(current &&
      isDeepStrictEqual(
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== "state")),
        expected,
      ), "Original debt capsule changed")
    yield* require(owner &&
      isDeepStrictEqual(
        Object.fromEntries(Object.entries(owner).filter(([key]) => key !== "state")),
        held!.participant,
      ), "Original debt participant changed")
    const rows = yield* tx
      .select()
      .from(Memberships)
      .where(eq(Memberships.capsule, held!.capsule.id))
      .orderBy(asc(Memberships.scope))
      .limit(65)
      .all()
    yield* require(rows.length === scopes.length &&
      rows.every(
        (row, index) => row.scope === scopes[index].scope && row.generation === scopes[index].generation,
      ), "Original debt membership changed")
    yield* records(held!.capsule)
    return held!.capsule
  })
  // A debt witness validates retained SQL rows after a prior transaction commits.
  // It authenticates no native owner and cannot become an active/start witness.
  const validateDebt = Effect.fn("RoutineEffect.validateDebt")(function* (input: unknown, owner: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(capsule, input)
    value.scopes.sort((left, right) => left.scope.localeCompare(right.scope))
    const selected = yield* decode(participant, owner)
    yield* require(value.participant === selected.id, "Original debt participant identity differs")
    const token = Object.freeze({})
    state.brands.set(token, {
      mode: "debt",
      capsule: structuredClone(value),
      participant: structuredClone(selected),
      scopes: new Map(),
    })
    yield* debt(token)
    return token
  })
  const retained = Effect.fn("RoutineEffect.retained")(function* (token: object, input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const original = yield* debt(token)
    const value = yield* decode(attempt, input)
    const saved = yield* tx
      .select()
      .from(Attempts)
      .where(
        and(
          eq(Attempts.id, value.id),
          eq(Attempts.capsule, original.id),
          eq(Attempts.generation, original.generation),
          eq(Attempts.owner, original.owner),
          eq(Attempts.kind, value.kind),
          eq(Attempts.purpose, value.purpose),
          eq(Attempts.digest, value.digest),
        ),
      )
      .get()
    yield* require(saved, "Exact original retained attempt required")
    return saved!
  })
  // Settlement remains possible after revocation, but only for the original
  // branded owner and exact consumed debt; it cannot make a new start eligible.
  const settle = Effect.fn("RoutineEffect.settle")(function* (token: object, input: unknown, receipt: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const original = yield* debt(token)
    const value = yield* decode(attempt, input)
    const digest = yield* decode(hash, receipt)
    const saved = yield* tx
      .update(Attempts)
      .set({ state: "settled", receipt: digest })
      .where(
        and(
          eq(Attempts.id, value.id),
          eq(Attempts.capsule, original.id),
          eq(Attempts.generation, original.generation),
          eq(Attempts.owner, original.owner),
          eq(Attempts.kind, value.kind),
          eq(Attempts.purpose, value.purpose),
          eq(Attempts.digest, value.digest),
          inArray(Attempts.state, ["started", "uncertain"]),
        ),
      )
      .returning()
      .get()
    yield* require(saved, "Original consumed effect debt changed")
    return saved!
  })
  const uncertain = Effect.fn("RoutineEffect.uncertain")(function* (token: object, input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const original = yield* debt(token)
    const value = yield* decode(attempt, input)
    const saved = yield* tx
      .update(Attempts)
      .set({ state: "uncertain" })
      .where(
        and(
          eq(Attempts.id, value.id),
          eq(Attempts.capsule, original.id),
          eq(Attempts.generation, original.generation),
          eq(Attempts.owner, original.owner),
          eq(Attempts.kind, value.kind),
          eq(Attempts.purpose, value.purpose),
          eq(Attempts.digest, value.digest),
          inArray(Attempts.state, ["reserved", "started"]),
        ),
      )
      .returning()
      .get()
    yield* require(saved, "Original pending effect debt changed")
    return saved!
  })
  const revokeScope = Effect.fn("RoutineEffect.revokeScope")(function* (input: unknown) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(revoke, input)
    const pending = yield* tx
      .select({ id: Revocations.id })
      .from(Revocations)
      .where(
        or(
          eq(Revocations.id, value.id),
          and(eq(Revocations.scope, value.scope), eq(Revocations.generation, value.generation)),
        ),
      )
      .get()
    yield* require(!pending, "Original scope revocation already exists")
    const selected = yield* tx
      .update(Scopes)
      .set({ state: "revoking" })
      .where(
        and(
          eq(Scopes.id, value.scope),
          eq(Scopes.generation, value.generation),
          eq(Scopes.projection, value.projection),
          eq(Scopes.state, "active"),
        ),
      )
      .returning()
      .get()
    yield* require(selected, "Original scope revocation CAS differs")
    const saved = yield* tx
      .insert(Revocations)
      .values({
        id: value.id,
        scope: value.scope,
        generation: value.generation,
        projection: value.projection,
        request: value.request,
        reason: value.reason,
        state: "requested",
      })
      .onConflictDoNothing()
      .returning()
      .get()
    yield* require(saved, "Original scope revocation already exists")
    const affected = tx
      .select({ id: Memberships.capsule })
      .from(Memberships)
      .where(and(eq(Memberships.scope, value.scope), eq(Memberships.generation, value.generation)))
    yield* tx
      .update(Capsules)
      .set({ state: "revoked" })
      .where(and(inArray(Capsules.id, affected), eq(Capsules.state, "active")))
      .run()
    yield* tx
      .update(Attempts)
      .set({ state: "uncertain" })
      .where(and(inArray(Attempts.capsule, affected), inArray(Attempts.state, ["reserved", "started"])))
      .run()
    return saved!
  })
  const finishRevocation = Effect.fn("RoutineEffect.finishRevocation")(function* (
    input: unknown,
    outcome: "published" | "uncertain",
  ) {
    yield* require(state.active, "SQL transaction validation scope is closed")
    const value = yield* decode(revoke, input)
    yield* require(outcome === "published" || outcome === "uncertain", "Exact revocation outcome required")
    const selected = yield* tx
      .select()
      .from(Scopes)
      .where(
        and(
          eq(Scopes.id, value.scope),
          eq(Scopes.generation, value.generation),
          eq(Scopes.projection, value.projection),
          eq(Scopes.state, "revoking"),
        ),
      )
      .get()
    yield* require(selected, "Original revoking scope changed")
    const saved = yield* tx
      .update(Revocations)
      .set({ state: outcome })
      .where(
        and(
          eq(Revocations.id, value.id),
          eq(Revocations.scope, value.scope),
          eq(Revocations.generation, value.generation),
          eq(Revocations.projection, value.projection),
          eq(Revocations.request, value.request),
          eq(Revocations.reason, value.reason),
          eq(Revocations.state, "requested"),
        ),
      )
      .returning()
      .get()
    yield* require(saved, "Original revocation outcome CAS differs")
    return saved!
  })
  return {
    stageScope,
    stageParticipant,
    stageCapsule,
    validate,
    validateDebt,
    retained,
    reserve,
    start,
    settle,
    uncertain,
    revokeScope,
    finishRevocation,
  }
}

/** Use only inside the caller's original supplied immediate transaction. This
 * opens no transaction. Join all effects before returning: never fork SQL work
 * or return an unexecuted effect for later use. Completion/failure/interruption
 * closes the SQL witness scope; this still grants NO native effect capability. */
export function within<A, E, R>(tx: Tx, use: (api: ReturnType<typeof make>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync((): State => ({ active: true, brands: new WeakMap() })),
    (state) => Effect.suspend(() => use(make(tx, state))),
    (state) =>
      Effect.sync(() => {
        state.active = false
        state.brands = new WeakMap()
      }),
  )
}
