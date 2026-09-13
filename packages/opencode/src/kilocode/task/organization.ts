import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineOrganizationDelegationTable as DelegationRow,
  RayaRoutineOrganizationMemberTable as MemberRow,
  RayaRoutineOrganizationRevisionTable as RevisionRow,
  RayaRoutineOrganizationTable as OrganizationRow,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { RayaTask } from "."
import type { Storage } from "@/storage/storage"
import { mutate } from "./mutation"

const MAX = 50
const EDGES = 500
const Name = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))
const Purpose = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Role = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))
const AgentID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Stamp = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15))

export const MemberInput = Schema.Struct({
  agentID: AgentID,
  role: Role,
  supervisorID: Schema.optional(AgentID),
})
export const Member = Schema.Struct({
  ...MemberInput.fields,
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(MAX)),
})
export const DelegationInput = Schema.Struct({ senderID: AgentID, recipientID: AgentID })
export const Delegation = Schema.Struct({
  ...DelegationInput.fields,
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(EDGES)),
})
const Members = Schema.Array(MemberInput).check(Schema.isMinLength(1), Schema.isMaxLength(MAX))
const Delegations = Schema.Array(DelegationInput).check(Schema.isMaxLength(EDGES))
export const Organization = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/)),
  name: Name,
  purpose: Schema.optional(Purpose),
  revision: Revision,
  archived: Schema.Boolean,
  archivedAt: Schema.optional(Stamp),
  createdAt: Stamp,
  updatedAt: Stamp,
  members: Schema.Array(Member).check(Schema.isMinLength(1), Schema.isMaxLength(MAX)),
  delegations: Schema.Array(Delegation).check(Schema.isMaxLength(EDGES)),
})
export const Create = Schema.Struct({
  name: Name,
  purpose: Schema.optional(Purpose),
  members: Members,
  delegations: Schema.optional(Delegations),
})
export const Update = Schema.Struct({
  expectedRevision: Revision,
  name: Schema.optional(Name),
  purpose: Schema.optional(Schema.Union([Purpose, Schema.Null])),
  members: Schema.optional(Members),
  delegations: Schema.optional(Delegations),
}).check(
  Schema.makeFilter((value) =>
    value.name !== undefined ||
    value.purpose !== undefined ||
    value.members !== undefined ||
    value.delegations !== undefined
      ? undefined
      : "Change the organization name, purpose, membership, or delegation graph.",
  ),
)
export const Archive = Schema.Struct({ expectedRevision: Revision })
export const Query = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX))),
})
export const Page = Schema.Struct({
  items: Schema.Array(Organization),
  next: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
})

export type Organization = typeof Organization.Type
export type Create = typeof Create.Type
export type Update = typeof Update.Type
export type Archive = typeof Archive.Type
export type Query = typeof Query.Type

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskOrganization.Invalid", {
  message: Schema.String,
}) {}
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("RayaTaskOrganization.NotFound", {
  message: Schema.String,
}) {}
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaTaskOrganization.Conflict", {
  message: Schema.String,
}) {}

const Cursor = Schema.Struct({ updated: Stamp, id: Organization.fields.id })

function encode(value: typeof Cursor.Type) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function cursor(value?: string) {
  if (value === undefined) return Effect.succeed(undefined)
  return Effect.try({
    try: () => JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    catch: () => new Invalid({ message: "This organization cursor is invalid." }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Cursor)),
    Effect.mapError(() => new Invalid({ message: "This organization cursor is invalid." })),
  )
}

function normalize(input: readonly (typeof MemberInput.Type)[]) {
  return input.map((item, position) => ({
    agentID: item.agentID,
    role: item.role.trim(),
    position,
    ...(item.supervisorID ? { supervisorID: item.supervisorID } : {}),
  }))
}

function graph(input: readonly (typeof Member.Type)[], delegations: readonly (typeof Delegation.Type)[]) {
  const ids = new Set(input.map((item) => item.agentID))
  if (ids.size !== input.length)
    return new Invalid({ message: "An organization cannot contain the same worker twice." })
  for (const item of input) {
    if (!item.supervisorID) continue
    if (item.supervisorID === item.agentID)
      return new Invalid({ message: "A worker cannot supervise itself in an organization." })
    if (!ids.has(item.supervisorID))
      return new Invalid({ message: "Every supervisor must be a member of the same organization." })
  }
  const edges = new Set<string>()
  for (const edge of delegations) {
    if (edge.senderID === edge.recipientID)
      return new Invalid({ message: "A worker cannot delegate to itself in an organization." })
    if (!ids.has(edge.senderID) || !ids.has(edge.recipientID))
      return new Invalid({ message: "Every delegation edge must connect two members of the same organization." })
    const key = `${edge.senderID}\u0000${edge.recipientID}`
    if (edges.has(key))
      return new Invalid({ message: "An organization cannot contain the same delegation edge twice." })
    edges.add(key)
  }
  const parents = new Map(input.map((item) => [item.agentID, item.supervisorID]))
  for (const item of input) {
    const seen = new Set<string>()
    let id: string | undefined = item.agentID
    while (id) {
      if (seen.has(id)) return new Invalid({ message: "Organization supervisor relationships cannot contain a cycle." })
      seen.add(id)
      id = parents.get(id)
    }
  }
}

function identifier() {
  return `org_${crypto.randomUUID().replaceAll("-", "")}`
}

function decoded(
  row: typeof OrganizationRow.$inferSelect,
  members: readonly (typeof MemberRow.$inferSelect)[],
  delegations: readonly (typeof DelegationRow.$inferSelect)[],
): Organization {
  return {
    version: 1,
    id: row.id,
    name: row.name,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    revision: row.revision,
    archived: row.archived_at !== null,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    members: members.map((item) => ({
      agentID: item.agent_id,
      role: item.role,
      position: item.position,
      ...(item.supervisor_id ? { supervisorID: item.supervisor_id } : {}),
    })),
    delegations: delegations.map((item) => ({
      senderID: item.sender_id,
      recipientID: item.recipient_id,
      position: item.position,
    })),
  }
}

type Workers = Pick<ReturnType<typeof RayaTask.make>, "get">
type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">

export namespace RayaTaskOrganization {
  export function make(database: Database.Interface, workers: Workers, storage: Store) {
    const db = database.db

    const validate = Effect.fn("RayaTaskOrganization.validate")(function* (
      input: readonly (typeof MemberInput.Type)[],
      edges: readonly (typeof DelegationInput.Type)[],
    ) {
      const members = normalize(input)
      const delegations = edges.map((item, position) => ({ ...item, position }))
      const invalid = graph(members, delegations)
      if (invalid) return yield* invalid
      for (const item of members) {
        yield* workers
          .get(item.agentID)
          .pipe(
            Effect.catchTag("RayaTask.NotFoundError", () =>
              Effect.fail(new Invalid({ message: `Organization worker ${item.agentID} does not exist.` })),
            ),
          )
      }
      return { members, delegations }
    })

    const read = Effect.fn("RayaTaskOrganization.read")(function* (row: typeof OrganizationRow.$inferSelect) {
      const members = yield* db
        .select()
        .from(MemberRow)
        .where(eq(MemberRow.organization_id, row.id))
        .orderBy(asc(MemberRow.position))
        .all()
        .pipe(Effect.orDie)
      const delegations = yield* db
        .select()
        .from(DelegationRow)
        .where(eq(DelegationRow.organization_id, row.id))
        .orderBy(asc(DelegationRow.position))
        .all()
        .pipe(Effect.orDie)
      return decoded(row, members, delegations)
    })

    const get = Effect.fn("RayaTaskOrganization.get")(function* (id: string) {
      const row = yield* db.select().from(OrganizationRow).where(eq(OrganizationRow.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFound({ message: "Organization not found." })
      return yield* read(row)
    })

    const create = Effect.fn("RayaTaskOrganization.create")(function* (input: Create) {
      const value = yield* Schema.decodeUnknownEffect(Create)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Provide a name and 1–50 valid organization members." })),
      )
      const graph = yield* validate(value.members, value.delegations ?? [])
      const now = Date.now()
      const item: Organization = {
        version: 1,
        id: identifier(),
        name: value.name.trim(),
        ...(value.purpose ? { purpose: value.purpose.trim() } : {}),
        revision: 1,
        archived: false,
        createdAt: now,
        updatedAt: now,
        members: graph.members,
        delegations: graph.delegations,
      }
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(OrganizationRow)
                .values({
                  id: item.id,
                  name: item.name,
                  purpose: item.purpose ?? null,
                  revision: item.revision,
                  archived_at: null,
                  time_created: now,
                  time_updated: now,
                })
                .run()
              yield* tx
                .insert(MemberRow)
                .values(
                  item.members.map((member) => ({
                    organization_id: item.id,
                    agent_id: member.agentID,
                    role: member.role,
                    position: member.position,
                    supervisor_id: member.supervisorID ?? null,
                    time_created: now,
                    time_updated: now,
                  })),
                )
                .run()
              if (item.delegations.length)
                yield* tx
                  .insert(DelegationRow)
                  .values(
                    item.delegations.map((edge) => ({
                      organization_id: item.id,
                      sender_id: edge.senderID,
                      recipient_id: edge.recipientID,
                      position: edge.position,
                      time_created: now,
                      time_updated: now,
                    })),
                  )
                  .run()
              yield* tx
                .insert(RevisionRow)
                .values({ organization_id: item.id, revision: 1, definition: JSON.stringify(item), time_created: now })
                .run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return item
    })

    const update = Effect.fn("RayaTaskOrganization.update")(function* (id: string, input: Update) {
      const value = yield* Schema.decodeUnknownEffect(Update)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Provide a valid organization revision and change." })),
      )
      const current = yield* get(id)
      const nextMembers = value.members ?? current.members
      const nextEdges = value.delegations ?? current.delegations
      const graph =
        value.members !== undefined || value.delegations !== undefined
          ? yield* validate(nextMembers, nextEdges)
          : undefined
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(OrganizationRow)
                .where(eq(OrganizationRow.id, id))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFound({ message: "Organization not found." })
              if (row.archived_at !== null)
                return yield* new Conflict({ message: "Archived organizations cannot be edited." })
              if (row.revision !== value.expectedRevision)
                return yield* new Conflict({ message: "This organization changed. Reload it before editing." })
              if (row.revision === Number.MAX_SAFE_INTEGER)
                return yield* new Conflict({ message: "This organization reached its revision limit." })
              const stored = yield* tx
                .select()
                .from(MemberRow)
                .where(eq(MemberRow.organization_id, row.id))
                .orderBy(asc(MemberRow.position))
                .all()
                .pipe(Effect.orDie)
              const storedEdges = yield* tx
                .select()
                .from(DelegationRow)
                .where(eq(DelegationRow.organization_id, row.id))
                .orderBy(asc(DelegationRow.position))
                .all()
                .pipe(Effect.orDie)
              const prior = decoded(row, stored, storedEdges)
              const now = Date.now()
              const next: Organization = {
                ...prior,
                name: value.name?.trim() ?? prior.name,
                purpose: value.purpose === null ? undefined : (value.purpose?.trim() ?? prior.purpose),
                revision: row.revision + 1,
                updatedAt: now,
                members: graph?.members ?? prior.members,
                delegations: graph?.delegations ?? prior.delegations,
              }
              yield* tx
                .update(OrganizationRow)
                .set({ name: next.name, purpose: next.purpose ?? null, revision: next.revision, time_updated: now })
                .where(and(eq(OrganizationRow.id, id), eq(OrganizationRow.revision, value.expectedRevision)))
                .run()
                .pipe(Effect.orDie)
              if (graph) {
                yield* tx.delete(MemberRow).where(eq(MemberRow.organization_id, id)).run().pipe(Effect.orDie)
                yield* tx
                  .insert(MemberRow)
                  .values(
                    graph.members.map((member) => ({
                      organization_id: id,
                      agent_id: member.agentID,
                      role: member.role,
                      position: member.position,
                      supervisor_id: member.supervisorID ?? null,
                      time_created: now,
                      time_updated: now,
                    })),
                  )
                  .run()
                  .pipe(Effect.orDie)
                yield* tx.delete(DelegationRow).where(eq(DelegationRow.organization_id, id)).run().pipe(Effect.orDie)
                if (graph.delegations.length)
                  yield* tx
                    .insert(DelegationRow)
                    .values(
                      graph.delegations.map((edge) => ({
                        organization_id: id,
                        sender_id: edge.senderID,
                        recipient_id: edge.recipientID,
                        position: edge.position,
                        time_created: now,
                        time_updated: now,
                      })),
                    )
                    .run()
                    .pipe(Effect.orDie)
              }
              yield* tx
                .insert(RevisionRow)
                .values({
                  organization_id: id,
                  revision: next.revision,
                  definition: JSON.stringify(next),
                  time_created: now,
                })
                .run()
                .pipe(Effect.orDie)
              return next
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const archive = Effect.fn("RayaTaskOrganization.archive")(function* (id: string, input: Archive) {
      const value = yield* Schema.decodeUnknownEffect(Archive)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Provide the organization revision being archived." })),
      )
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(OrganizationRow)
                .where(eq(OrganizationRow.id, id))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFound({ message: "Organization not found." })
              if (row.revision !== value.expectedRevision)
                return yield* new Conflict({ message: "This organization changed. Reload it before archiving." })
              if (row.archived_at !== null)
                return yield* new Conflict({ message: "This organization is already archived." })
              if (row.revision === Number.MAX_SAFE_INTEGER)
                return yield* new Conflict({ message: "This organization reached its revision limit." })
              const stored = yield* tx
                .select()
                .from(MemberRow)
                .where(eq(MemberRow.organization_id, row.id))
                .orderBy(asc(MemberRow.position))
                .all()
                .pipe(Effect.orDie)
              const storedEdges = yield* tx
                .select()
                .from(DelegationRow)
                .where(eq(DelegationRow.organization_id, row.id))
                .orderBy(asc(DelegationRow.position))
                .all()
                .pipe(Effect.orDie)
              const prior = decoded(row, stored, storedEdges)
              const now = Date.now()
              const next: Organization = {
                ...prior,
                revision: row.revision + 1,
                archived: true,
                archivedAt: now,
                updatedAt: now,
              }
              yield* tx
                .update(OrganizationRow)
                .set({ revision: next.revision, archived_at: now, time_updated: now })
                .where(and(eq(OrganizationRow.id, id), eq(OrganizationRow.revision, value.expectedRevision)))
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .insert(RevisionRow)
                .values({
                  organization_id: id,
                  revision: next.revision,
                  definition: JSON.stringify(next),
                  time_created: now,
                })
                .run()
                .pipe(Effect.orDie)
              return next
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const list = Effect.fn("RayaTaskOrganization.list")(function* (query: Query = {}) {
      const value = yield* Schema.decodeUnknownEffect(Query)(query).pipe(
        Effect.mapError(() => new Invalid({ message: "Organization pages are limited to 50 items." })),
      )
      const after = yield* cursor(value.cursor)
      const archived = value.archived ?? false
      const limit = value.limit ?? MAX
      const rows = yield* db
        .select()
        .from(OrganizationRow)
        .where(
          and(
            archived ? isNotNull(OrganizationRow.archived_at) : isNull(OrganizationRow.archived_at),
            after
              ? or(
                  lt(OrganizationRow.time_updated, after.updated),
                  and(eq(OrganizationRow.time_updated, after.updated), sql`${OrganizationRow.id} < ${after.id}`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(OrganizationRow.time_updated), desc(OrganizationRow.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const items = yield* Effect.forEach(rows.slice(0, limit), read)
      const last = items.at(-1)
      return {
        items,
        ...(rows.length > limit && last ? { next: encode({ updated: last.updatedAt, id: last.id }) } : {}),
      }
    })

    const hasActive = Effect.fn("RayaTaskOrganization.hasActive")(function* (agentID: string) {
      const row = yield* db
        .select({ count: count() })
        .from(MemberRow)
        .innerJoin(OrganizationRow, eq(OrganizationRow.id, MemberRow.organization_id))
        .where(and(eq(MemberRow.agent_id, agentID), isNull(OrganizationRow.archived_at)))
        .get()
        .pipe(Effect.orDie)
      return (row?.count ?? 0) > 0
    })

    const contains = Effect.fn("RayaTaskOrganization.contains")(function* (id: string, agents: readonly string[]) {
      if (agents.length < 1 || agents.length > MAX || new Set(agents).size !== agents.length) return false
      const row = yield* db
        .select({ count: count() })
        .from(MemberRow)
        .innerJoin(OrganizationRow, eq(OrganizationRow.id, MemberRow.organization_id))
        .where(
          and(
            eq(OrganizationRow.id, id),
            isNull(OrganizationRow.archived_at),
            inArray(MemberRow.agent_id, [...agents]),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row?.count === agents.length
    })

    const shares = Effect.fn("RayaTaskOrganization.shares")(function* (senderID: string, recipientID: string) {
      if (senderID === recipientID) return false
      const rows = yield* db
        .select({ id: MemberRow.organization_id })
        .from(MemberRow)
        .innerJoin(OrganizationRow, eq(OrganizationRow.id, MemberRow.organization_id))
        .where(and(eq(MemberRow.agent_id, senderID), isNull(OrganizationRow.archived_at)))
        .all()
        .pipe(Effect.orDie)
      const ids = rows.map((row) => row.id)
      if (!ids.length) return false
      const row = yield* db
        .select({ count: count() })
        .from(MemberRow)
        .where(and(eq(MemberRow.agent_id, recipientID), inArray(MemberRow.organization_id, ids)))
        .get()
        .pipe(Effect.orDie)
      return (row?.count ?? 0) > 0
    })

    const authorize = Effect.fn("RayaTaskOrganization.authorize")(function* (input: {
      id: string
      revision?: number
      senderID: string
      recipientID: string
    }) {
      const item = yield* get(input.id)
      if (item.archived) return yield* new Invalid({ message: "This organization is archived." })
      if (input.revision !== undefined && item.revision !== input.revision)
        return yield* new Conflict({ message: "This organization changed. Reload it before delegating work." })
      const ids = new Set(item.members.map((member) => member.agentID))
      if (!ids.has(input.senderID) || !ids.has(input.recipientID))
        return yield* new Invalid({ message: "Both workers must be active members of this organization." })
      if (!item.delegations.some((edge) => edge.senderID === input.senderID && edge.recipientID === input.recipientID))
        return yield* new Invalid({ message: "This organization does not permit that worker-to-worker delegation." })
      return { id: item.id, name: item.name, revision: item.revision }
    })

    return {
      list,
      get,
      create: (...args: Parameters<typeof create>) => mutate(storage, create(...args), "Organization"),
      update: (...args: Parameters<typeof update>) => mutate(storage, update(...args), "Organization"),
      archive: (...args: Parameters<typeof archive>) => mutate(storage, archive(...args), "Organization"),
      hasActive,
      contains,
      shares,
      authorize,
    }
  }
}
