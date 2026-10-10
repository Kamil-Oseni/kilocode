import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, asc, eq, inArray, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import z from "zod"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectCapsule as Capsules,
  RoutineEffectMembership as Memberships,
  RoutineEffectRevocation as Revocations,
} from "@opencode-ai/core/kilocode/routine-effect.sql"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().regex(/^[a-f0-9]{32}$/)
const name = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 256 && !value.includes("\0"))
const kind = z.enum(["principal", "organization", "goal", "run", "session", "delegation", "workspace", "config"])
const key = z.object({ kind, principal: name }).strict()
const request = z
  .object({ request: hash, reason: name, keys: z.array(key).min(1).max(1024) })
  .strict()
  .refine(
    (value) => new Set(value.keys.map((row) => JSON.stringify([row.kind, row.principal]))).size === value.keys.length,
  )

const intent = z
  .object({
    id,
    scope: hash,
    generation: id,
    projection: hash,
    request: hash,
    reason: name,
    state: z.enum(["requested", "published", "uncertain"]),
  })
  .strict()
const marker = Symbol("Original negative publication owner")
export type Owner = Readonly<{ [marker]: true }>
const scope = z
  .object({
    id: hash,
    kind,
    principal: name,
    birth: z
      .string()
      .regex(/^\d{1,20}$/)
      .refine((value) => BigInt(value) > 0n && BigInt(value) <= 18446744073709551615n),
    generation: id,
    projection: hash,
    state: z.enum(["active", "revoking"]),
  })
  .strict()

export class Refusal extends Schema.TaggedErrorClass<Refusal>()("RoutineEffectRevocation.Refusal", {
  message: Schema.String,
}) {}

function require(value: unknown, message: string) {
  return value ? Effect.void : Effect.fail(new Refusal({ message }))
}

function decode<T>(schema: z.ZodType<T>, value: unknown) {
  return Effect.try({
    try: () => schema.parse(value),
    catch: () => new Refusal({ message: "Bounded revocation identity required" }),
  })
}

// A selected Database is captured once. This module supplies only a negative
// barrier: neither keys, request hashes nor returned SQL rows authenticate a
// process/run/step or authorize FS/native effects. The caller must bind physical
// Storage to this original profile before using it, and refuse publication on
// every error. No FS lock, operation or await belongs inside this transaction.
export function make(database: Database.Interface) {
  const db = database.db
  const owners = new WeakMap<
    Owner,
    {
      owned: readonly z.infer<typeof intent>[]
      retained: readonly z.infer<typeof intent>[]
      scopes: readonly z.infer<typeof scope>[]
      capsules: readonly (typeof Capsules.$inferSelect)[]
    }
  >()
  const revoke = Effect.fn("RoutineEffectRevocation.revoke")(function* (input: unknown) {
    const value = yield* decode(request, input)
    const receipt = yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const selected = yield* tx
            .select()
            .from(Scopes)
            .where(
              and(
                inArray(Scopes.state, ["active", "revoking"]),
                or(
                  ...kind.options.map((group) => {
                    const keys = value.keys.filter((row) => row.kind === group).map((row) => row.principal)
                    return and(eq(Scopes.kind, group), inArray(Scopes.principal, keys))
                  }),
                ),
              ),
            )
            .orderBy(asc(Scopes.id))
            .limit(1025)
            .all()
          yield* require(selected.length <= 1024, "Revocation scope capacity exceeded")
          const owned: z.infer<typeof intent>[] = []
          const retained: z.infer<typeof intent>[] = []
          const scopes: z.infer<typeof scope>[] = []
          for (const row of selected) {
            const original = yield* decode(scope, row)
            scopes.push(Object.freeze({ ...original, state: "revoking" }))
            const expected = {
              id: createHash("sha256")
                .update(
                  JSON.stringify([
                    "raya.routine.revocation.v1",
                    value.request,
                    original.id,
                    original.generation,
                    original.projection,
                  ]),
                )
                .digest("hex")
                .slice(0, 32),
              scope: original.id,
              generation: original.generation,
              projection: original.projection,
              request: value.request,
              reason: value.reason,
              state: "requested" as const,
            }
            const held = yield* tx
              .select()
              .from(Revocations)
              .where(and(eq(Revocations.scope, original.id), eq(Revocations.generation, original.generation)))
              .get()
            // Every unresolved original publication is debt. Repeating its public
            // request cannot reconstruct a lost private owner or replay its FS work.
            if (held?.state === "published") {
              const saved = yield* decode(intent, held)
              yield* require(saved.projection === original.projection &&
                original.state === "revoking", "Published revocation scope differs")
              retained.push(Object.freeze(saved))
              continue
            }
            yield* require(!held, "Original revocation intent is unresolved")
            yield* tx.insert(Revocations).values(expected).run()
            owned.push(Object.freeze(expected))
          }
          if (!selected.length) return { owned, retained, scopes, capsules: [] }
          const ids = selected.map((row) => row.id)
          const members = tx
            .select({ id: Memberships.capsule })
            .from(Memberships)
            .innerJoin(Scopes, and(eq(Scopes.id, Memberships.scope), eq(Scopes.generation, Memberships.generation)))
            .where(inArray(Scopes.id, ids))
          const capsules = yield* tx
            .select()
            .from(Capsules)
            .where(and(eq(Capsules.state, "active"), inArray(Capsules.id, members)))
            .orderBy(asc(Capsules.id))
            .limit(8193)
            .all()
          yield* require(capsules.length <= 8192, "Revocation capsule capacity exceeded")
          if (capsules.length)
            yield* tx
              .update(Capsules)
              .set({ state: "revoked" })
              .where(
                and(
                  eq(Capsules.state, "active"),
                  inArray(
                    Capsules.id,
                    capsules.map((row) => row.id),
                  ),
                ),
              )
              .run()
          yield* tx
            .update(Scopes)
            .set({ state: "revoking" })
            .where(and(eq(Scopes.state, "active"), inArray(Scopes.id, ids)))
            .run()
          // Commit finishes before the caller can publish FS bytes. A later FS error
          // leaves these original requested intents and revoked records intact.
          return {
            owned,
            retained,
            scopes,
            capsules: capsules.map((row) => Object.freeze({ ...row, state: "revoked" as const })),
          }
        }),
      { behavior: "immediate" },
    )
    // Mint only after the original transaction has actually committed. A copied
    // or foreign make() object cannot settle this selected database's records.
    const owner: Owner = Object.freeze({ [marker]: true })
    owners.set(owner, {
      owned: Object.freeze(receipt.owned),
      retained: Object.freeze(receipt.retained),
      scopes: Object.freeze(receipt.scopes),
      capsules: Object.freeze(receipt.capsules),
    })
    return owner
  })
  const finish = Effect.fn("RoutineEffectRevocation.finish")(function* (
    owner: Owner,
    outcome: "published" | "uncertain",
  ) {
    const original = owners.get(owner)
    yield* require(original, "Original private publication owner required")
    yield* require(outcome === "published" || outcome === "uncertain", "Known publication outcome required")
    if (!original) return
    yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          for (const row of original.scopes) {
            const current = yield* tx.select().from(Scopes).where(eq(Scopes.id, row.id)).get()
            yield* require(isDeepStrictEqual(current, row), "Original revocation scope changed")
          }
          for (const row of original.capsules) {
            const current = yield* tx.select().from(Capsules).where(eq(Capsules.id, row.id)).get()
            yield* require(isDeepStrictEqual(current, row), "Original revoked capsule changed")
          }
          for (const row of original.retained) {
            const current = yield* tx.select().from(Revocations).where(eq(Revocations.id, row.id)).get()
            yield* require(isDeepStrictEqual(current, row), "Retained publication intent changed")
          }
          for (const row of original.owned) {
            const current = yield* tx.select().from(Revocations).where(eq(Revocations.id, row.id)).get()
            yield* require(isDeepStrictEqual(current, row) ||
              isDeepStrictEqual(current, { ...row, state: outcome }), "Original publication intent changed")
            if (current?.state === outcome) continue
            yield* tx
              .update(Revocations)
              .set({ state: outcome })
              .where(
                and(
                  eq(Revocations.id, row.id),
                  eq(Revocations.state, "requested"),
                  eq(Revocations.request, row.request),
                  eq(Revocations.scope, row.scope),
                  eq(Revocations.generation, row.generation),
                  eq(Revocations.projection, row.projection),
                ),
              )
              .run()
          }
        }),
      { behavior: "immediate" },
    )
  })
  return Object.freeze({ revoke, finish })
}
