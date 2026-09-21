import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Option, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { commitment } from "./commitment"
import { RayaTask } from "./index"
import { RayaTaskInbox, type Publish } from "./inbox"

const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const body = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000))
const State = Schema.Literals(["queued", "accepted", "running", "needs_input", "completed", "failed", "cancelled"])
const live = ["queued", "accepted", "running", "needs_input"] as const
const DEPTH = 3
const FAN = 4

export const Artifact = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4096)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  tool: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(128)),
  callID: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(128)),
})
export const Artifacts = Schema.Array(Artifact).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16),
  Schema.makeFilter((items) =>
    new Set(items.map((item) => item.path)).size === items.length ? undefined : "Artifact paths must be unique.",
  ),
)

export const Request = Schema.Struct({
  source: token,
  senderID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  recipientID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  organizationID: Schema.optional(Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/))),
  organizationRevision: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
  objective: body,
  expected: Schema.optional(body),
  context: Schema.optional(body),
  deadline: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15)),
  ),
  budget: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000))),
  artifacts: Schema.optional(Artifacts),
}).check(
  Schema.makeFilter((value) =>
    (value.organizationID === undefined) === (value.organizationRevision === undefined)
      ? undefined
      : "Organization ID and revision must be provided together.",
  ),
)

export const Record = Schema.Struct({
  id: token,
  source: token,
  senderID: Request.fields.senderID,
  recipientID: Request.fields.recipientID,
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  organizationID: Schema.optional(Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/))),
  organizationName: Schema.optional(Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))),
  organizationRevision: Request.fields.organizationRevision,
  workspace: Schema.optional(Schema.String),
  objective: body,
  expected: Schema.optional(body),
  context: Schema.optional(body),
  deadline: Request.fields.deadline,
  budget: Request.fields.budget,
  depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DEPTH })),
  state: State,
  childRunID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  artifacts: Schema.optional(Artifacts),
  response: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  time: Schema.Number,
})

export const Lineage = Schema.Struct({
  record: Record,
  above: Schema.Array(Record),
  below: Schema.Array(Record),
})

export type Request = typeof Request.Type
export type Record = typeof Record.Type
export type Lineage = typeof Lineage.Type
export type Artifact = typeof Artifact.Type

export function artifacts(raw: string | null) {
  if (!raw) return undefined
  return Option.getOrUndefined(
    Option.flatMap(Option.liftThrowable(JSON.parse)(raw), Schema.decodeUnknownOption(Artifacts)),
  )
}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaTaskDelegation.Conflict", {
  message: Schema.String,
}) {}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskDelegation.Invalid", {
  message: Schema.String,
}) {}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function key(source: string) {
  return `rdl_${digest(source).slice(0, 48)}`
}

function origin(kind: "ask" | "sent" | "reply" | "start", source: string) {
  const raw = `${kind}:${source}`
  return Schema.is(token)(raw) ? raw : `${kind}:${digest(source).slice(0, 40)}`
}

function folder(value?: string) {
  const path = value?.trim()
  if (!path) return
  return path.replaceAll("\\", "/").replace(/\/+$/, "")
}

export const AWAY = "This request cannot leave the sender's workspace."
export const GONE = "This worker is no longer available. Delegation is not started."
const PAUSED = "This worker is paused. Delegation is not started until it is enabled."
const ACCESS = "Review this older routine's workspace access before starting delegated work."
const DENIALS = new Set([AWAY, GONE, PAUSED, ACCESS])

export function scope(sender: Pick<RayaTask.Agent, "dir">, recipient: Pick<RayaTask.Agent, "dir">) {
  const from = folder(sender.dir)
  const to = folder(recipient.dir)
  if (from && to && from !== to) return
  return to ?? from
}

export function ceiling(
  sender: Pick<RayaTask.Agent, "role" | "access" | "tools">,
  recipient: Pick<RayaTask.Agent, "role" | "access" | "tools">,
) {
  if (RayaTask.brief(sender) || RayaTask.brief(recipient)) return { ...recipient, access: "brief" as const }
  if (sender.tools === undefined) return recipient
  if (recipient.tools === undefined) return { ...recipient, tools: [...sender.tools] }
  const allowed = new Set(sender.tools)
  return { ...recipient, tools: recipient.tools.filter((tool) => allowed.has(tool)) }
}

export function prompt(sender: RayaTask.Agent, recipient: RayaTask.Agent, request: Request) {
  return [
    "Answer this request from another worker. The standing assignment and schedule are unchanged. Do not rewrite them, and do not treat this as a request to run the recurring job now.",
    `Requesting worker: ${sender.name} (${sender.role})`,
    request.organizationID
      ? `Organization: ${request.organizationID} (revision ${request.organizationRevision})`
      : undefined,
    `Request objective:\n${request.objective}`,
    request.expected ? `Expected result:\n${request.expected}` : undefined,
    request.context ? `Permitted context:\n${request.context}` : undefined,
    request.deadline !== undefined ? `Deadline: ${new Date(request.deadline).toISOString()}` : undefined,
    request.budget !== undefined ? `Maximum model cost: $${request.budget}` : undefined,
    request.artifacts?.length
      ? `Verified input files:\n${request.artifacts.map((item) => `- ${item.path} (SHA-256 ${item.sha256})`).join("\n")}`
      : undefined,
    `Your standing assignment:\n${recipient.objective}`,
    "Do not invent a worker reply that has not arrived. Attribute findings to this request.",
  ]
    .filter((line): line is string => !!line)
    .join("\n\n")
}

function decode(row: typeof Delegation.$inferSelect): Record {
  const files = artifacts(row.artifacts)
  return {
    id: row.id,
    source: row.source,
    senderID: row.sender_id,
    recipientID: row.recipient_id,
    objective: row.objective,
    depth: row.depth,
    state: row.state as Record["state"],
    time: row.time_created,
    ...(row.parent_id ? { parentID: row.parent_id } : {}),
    ...(row.parent_run_id ? { parentRunID: row.parent_run_id } : {}),
    ...(row.organization_id ? { organizationID: row.organization_id } : {}),
    ...(row.organization_name ? { organizationName: row.organization_name } : {}),
    ...(row.organization_revision !== null ? { organizationRevision: row.organization_revision } : {}),
    ...(row.workspace ? { workspace: row.workspace } : {}),
    ...(row.expected ? { expected: row.expected } : {}),
    ...(row.context ? { context: row.context } : {}),
    ...(row.deadline !== null ? { deadline: row.deadline } : {}),
    ...(row.budget !== null ? { budget: row.budget } : {}),
    ...(row.child_run_id ? { childRunID: row.child_run_id } : {}),
    ...(row.session_id ? { sessionID: SessionID.make(row.session_id) } : {}),
    ...(files ? { artifacts: files } : {}),
    ...(row.response ? { response: row.response } : {}),
    ...(row.cost !== null ? { cost: row.cost } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

function same(saved: Record, value: Request) {
  return (
    saved.senderID === value.senderID &&
    saved.recipientID === value.recipientID &&
    saved.objective === value.objective &&
    saved.expected === value.expected &&
    saved.context === value.context &&
    saved.parentID === value.parentID &&
    saved.parentRunID === value.parentRunID &&
    saved.organizationID === value.organizationID &&
    saved.organizationRevision === value.organizationRevision &&
    saved.deadline === value.deadline &&
    saved.budget === value.budget &&
    isDeepStrictEqual(saved.artifacts, value.artifacts)
  )
}

function cards(row: Record, sender: RayaTask.Agent, recipient: RayaTask.Agent): Publish[] {
  const note =
    row.state === "queued"
      ? "This request is queued until the worker is free. It has not started."
      : row.state === "failed"
        ? row.reason || "This request was not started."
        : undefined
  const provenance = row.organizationName
    ? `${row.organizationName} · organization revision ${row.organizationRevision}`
    : undefined
  const files = row.artifacts?.length
    ? ["Verified files:", ...row.artifacts.map((item) => `- ${item.path} (SHA-256 ${item.sha256})`)].join("\n")
    : undefined
  const ask = [`Request from ${sender.name}:`, provenance, row.objective, files, note]
    .filter((line): line is string => !!line)
    .join("\n")
  const sent = [`Asked ${recipient.name}:`, provenance, row.objective, files, note]
    .filter((line): line is string => !!line)
    .join("\n")
  const id = Schema.is(token)(row.id) ? row.id : undefined
  return [
    {
      agentID: recipient.id,
      source: origin("ask", row.source),
      kind: "delegation",
      body: ask.slice(0, 8000),
      ...(id ? { occurrenceID: id } : {}),
    },
    {
      agentID: sender.id,
      source: origin("sent", row.source),
      kind: "delegation",
      body: sent.slice(0, 8000),
      ...(id ? { occurrenceID: id } : {}),
    },
  ]
}

function admission(row: Record, sender: RayaTask.Agent, recipient: RayaTask.Agent) {
  const denied = row.state === "failed" && !!row.reason && DENIALS.has(row.reason)
  if (row.state !== "queued" && !denied) return []
  const initial: Record = denied ? row : { ...row, state: "queued", reason: undefined }
  const reply = denied ? replied(row, recipient) : undefined
  return reply ? [...cards(initial, sender, recipient), reply] : cards(initial, sender, recipient)
}

export function begun(row: Record): Publish | undefined {
  if (row.state !== "accepted" && row.state !== "running") return
  return {
    agentID: row.senderID,
    source: origin("start", row.source),
    kind: "delegation",
    body: "This worker started the request. It is no longer only queued.",
    sessionID: row.sessionID,
    ...(row.childRunID && Schema.is(token)(row.childRunID) ? { occurrenceID: row.childRunID } : {}),
  }
}

export function billed(row: Pick<Record, "cost">) {
  const amount = row.cost
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
    return "Child cost was not recorded. No amount was invented; bounded work remains conservatively reserved."
  return `Child cost $${amount}. It counts against the branch limit and remains separate from the requesting worker's direct model-cost total.`
}

export function credited(kids: readonly Record[], name?: (id: string) => string) {
  if (!kids.length) return [] as string[]
  const lines = [
    "Contributing worker requests. Their costs count against the branch limit and remain separate from this run's direct model-cost total.",
  ]
  for (const row of kids) {
    const who = name?.(row.recipientID) ?? row.recipientID
    if (row.state === "completed") {
      lines.push(`${who}: completed. ${billed(row)}`)
      continue
    }
    if (row.state === "queued" || row.state === "accepted" || row.state === "running" || row.state === "needs_input") {
      lines.push(`${who}: ${row.state}. No completed reply yet. This is not a completed worker result.`)
      continue
    }
    lines.push(
      `${who}: ${row.state}. ${row.reason || "No completed worker reply."} This is not a completed worker reply.`,
    )
  }
  return lines
}

export function replied(row: Record, recipient: RayaTask.Agent): Publish | undefined {
  if (row.state === "queued" || row.state === "accepted" || row.state === "running") return
  const findings = row.response?.trim()
  const lines =
    row.state === "completed"
      ? [
          `Reply from ${recipient.name}.`,
          findings || "No written reply was saved. This is not invented success.",
          billed(row),
        ]
      : [
          `Delegation ${row.state} (${recipient.name}).`,
          row.reason || findings || "No written reply was saved.",
          "This is not a completed worker reply.",
          billed(row),
        ]
  const body = lines.join("\n").slice(0, 8000)
  if (!body.trim()) return
  return {
    agentID: row.senderID,
    source: origin("reply", row.state === "needs_input" ? `needs_input:${row.source}` : row.source),
    kind: "delegation",
    body,
    sessionID: row.sessionID,
    ...(row.childRunID && Schema.is(token)(row.childRunID) ? { occurrenceID: row.childRunID } : {}),
  }
}

export namespace RayaTaskDelegation {
  export function make(
    database: Database.Interface,
    policy?: (input: {
      id: string
      revision?: number
      senderID: string
      recipientID: string
    }) => Effect.Effect<{ id: string; name: string; revision: number; budget?: number }, unknown>,
    shares?: (senderID: string, recipientID: string) => Effect.Effect<boolean, unknown>,
  ) {
    const db = database.db
    const inbox = RayaTaskInbox.make(database)
    const publish = (items: readonly Publish[]) =>
      Effect.forEach(items, (item) =>
        inbox.publish(item).pipe(
          Effect.catchTag("RayaTaskInbox.Conflict", () =>
            Effect.fail(new Conflict({ message: "A delegation message source already has different content." })),
          ),
          Effect.catchTag("RayaTaskInbox.Invalid", Effect.die),
        ),
      )
    const reply = (record: Record, recipient: RayaTask.Agent) => {
      const item = replied(record, recipient)
      return item ? publish([item]) : Effect.void
    }
    const begin = (record: Record) => {
      const item = begun(record)
      return item ? publish([item]) : Effect.void
    }
    const get = Effect.fn("RayaTaskDelegation.get")(function* (id: string) {
      const row = yield* db.select().from(Delegation).where(eq(Delegation.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new Invalid({ message: "This delegation request was not found." })
      return decode(row)
    })
    const lookup = Effect.fn("RayaTaskDelegation.lookup")(function* (source: string) {
      const row = yield* db.select().from(Delegation).where(eq(Delegation.source, source)).get().pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })
    const ancestors = Effect.fn("RayaTaskDelegation.ancestors")(function* (id?: string) {
      const seen: Record[] = []
      let current = id
      while (current) {
        if (seen.length >= DEPTH) return yield* new Invalid({ message: "This delegation chain is too deep." })
        const row = yield* db.select().from(Delegation).where(eq(Delegation.id, current)).get().pipe(Effect.orDie)
        if (!row) return yield* new Invalid({ message: "The parent delegation request was not found." })
        const item = decode(row)
        seen.push(item)
        current = item.parentID
      }
      return seen
    })
    const outstanding = Effect.fn("RayaTaskDelegation.outstanding")(function* (senderID: string, parentID?: string) {
      const rows = yield* (
        parentID
          ? db
              .select()
              .from(Delegation)
              .where(and(eq(Delegation.parent_id, parentID), inArray(Delegation.state, [...live])))
          : db
              .select()
              .from(Delegation)
              .where(
                and(
                  eq(Delegation.sender_id, senderID),
                  isNull(Delegation.parent_id),
                  inArray(Delegation.state, [...live]),
                ),
              )
      )
        .all()
        .pipe(Effect.orDie)
      return rows.length
    })
    const admit = Effect.fn("RayaTaskDelegation.admit")(function* (
      input: Request,
      sender: RayaTask.Agent,
      recipient: RayaTask.Agent,
      gone?: boolean,
      allocation?: { limit: number; spent: number },
    ) {
      const value = yield* Schema.decodeUnknownEffect(Request)(input).pipe(
        Effect.mapError(
          () => new Invalid({ message: "Delegation requests need a stable source and a non-empty objective." }),
        ),
      )
      if (value.senderID !== sender.id || value.recipientID !== recipient.id)
        return yield* new Invalid({ message: "Delegation identities must match the requesting and receiving workers." })
      if (value.senderID === value.recipientID)
        return yield* new Invalid({ message: "A worker cannot delegate to itself." })
      const workspace = scope(sender, recipient)
      if (value.deadline !== undefined && value.deadline <= Date.now())
        return yield* new Invalid({ message: "This delegation deadline has already passed." })
      const prior = yield* lookup(value.source)
      if (prior) {
        if (!same(prior, value))
          return yield* new Conflict({ message: "This delegation source already has a different request." })
        yield* publish(admission(prior, sender, recipient))
        return { record: prior, created: false }
      }
      const organization = value.organizationID
        ? policy
          ? yield* policy({
              id: value.organizationID,
              revision: value.organizationRevision,
              senderID: value.senderID,
              recipientID: value.recipientID,
            }).pipe(
              Effect.mapError(() => new Invalid({ message: "This organization does not authorize that delegation." })),
            )
          : yield* new Invalid({ message: "Organization delegation policy is unavailable." })
        : undefined
      if (!value.organizationID && shares && (yield* shares(value.senderID, value.recipientID).pipe(Effect.orDie)))
        return yield* new Invalid({
          message: "Choose the organization and its current revision for this worker-to-worker delegation.",
        })
      const lineage = yield* ancestors(value.parentID)
      const parent = lineage[0]
      if (parent?.organizationID && value.organizationID !== parent.organizationID)
        return yield* new Invalid({
          message: "A delegated follow-on must stay in its parent organization's authority graph.",
        })
      if (parent?.deadline !== undefined && value.deadline === undefined)
        return yield* new Invalid({ message: "A delegated follow-on must keep its parent deadline." })
      if (parent?.deadline !== undefined && value.deadline !== undefined && value.deadline > parent.deadline)
        return yield* new Invalid({ message: "A delegated follow-on cannot extend its parent deadline." })
      if (parent?.budget !== undefined && value.budget === undefined)
        return yield* new Invalid({ message: "A delegated follow-on must keep a bounded model-cost budget." })
      if (parent?.budget !== undefined && value.budget !== undefined && value.budget > parent.budget)
        return yield* new Invalid({ message: "A delegated follow-on cannot exceed its parent model-cost budget." })
      const depth = lineage.length + 1
      if (depth > DEPTH) return yield* new Invalid({ message: "This delegation chain is too deep." })
      const ids = new Set(lineage.flatMap((item) => [item.senderID, item.recipientID]))
      ids.add(value.senderID)
      if (ids.has(value.recipientID)) return yield* new Invalid({ message: "This delegation would create a cycle." })
      if (value.parentID && lineage[0] && lineage[0].id !== value.parentID)
        return yield* new Invalid({ message: "The parent delegation request was not found." })
      const count = yield* outstanding(value.senderID, value.parentID)
      if (count >= FAN)
        return yield* new Invalid({ message: "This worker already has too many outstanding delegated requests." })
      if (allocation && value.budget === undefined)
        return yield* new Invalid({ message: "Delegated work from this bounded run requires a model-cost budget." })
      if (allocation && !value.parentRunID)
        return yield* new Invalid({ message: "Bounded delegated work requires its parent run identity." })
      if (gone)
        return yield* persist(value, sender, recipient, workspace, depth, "failed", GONE, organization, allocation)
      if (sender.dir?.trim() && recipient.dir?.trim() && workspace === undefined)
        return yield* persist(value, sender, recipient, workspace, depth, "failed", AWAY, organization, allocation)
      if (!recipient.enabled)
        return yield* persist(value, sender, recipient, workspace, depth, "failed", PAUSED, organization, allocation)
      if (recipient.access === undefined)
        return yield* persist(value, sender, recipient, workspace, depth, "failed", ACCESS, organization, allocation)
      return yield* persist(value, sender, recipient, workspace, depth, "queued", undefined, organization, allocation)
    })
    const persist = Effect.fn("RayaTaskDelegation.persist")(function* (
      value: Request,
      sender: RayaTask.Agent,
      recipient: RayaTask.Agent,
      workspace: string | undefined,
      depth: number,
      state: Record["state"],
      reason?: string,
      organization?: { id: string; name: string; revision: number; budget?: number },
      allocation?: { limit: number; spent: number },
    ) {
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const committed = (rows: readonly (typeof Delegation.$inferSelect)[]): Effect.Effect<number> =>
                Effect.gen(function* () {
                  let total = 0
                  for (const row of rows) {
                    if (
                      row.state === "queued" ||
                      row.state === "accepted" ||
                      row.state === "running" ||
                      row.state === "needs_input"
                    ) {
                      total += row.budget ?? 0
                      continue
                    }
                    if (row.cost === null) {
                      total += row.session_id ? (row.budget ?? 0) : 0
                      continue
                    }
                    const children = yield* tx
                      .select()
                      .from(Delegation)
                      .where(eq(Delegation.parent_id, row.id))
                      .all()
                      .pipe(Effect.orDie)
                    total += row.cost + (yield* committed(children))
                  }
                  return total
                })
              if (organization) {
                const owner = yield* tx
                  .select({
                    revision: Organization.revision,
                    budget: Organization.budget,
                    archived: Organization.archived_at,
                  })
                  .from(Organization)
                  .where(eq(Organization.id, organization.id))
                  .get()
                  .pipe(Effect.orDie)
                if (!owner || owner.archived !== null || owner.revision !== organization.revision)
                  return yield* new Invalid({
                    message: "This organization changed. Reload it before delegating work.",
                  })
                if (!value.parentID && owner.budget !== null) {
                  if (value.budget === undefined)
                    return yield* new Invalid({
                      message: "Work in this organization requires a model-cost budget.",
                    })
                  const rows = yield* tx
                    .select()
                    .from(Delegation)
                    .where(eq(Delegation.organization_id, organization.id))
                    .all()
                    .pipe(Effect.orDie)
                  if (commitment(rows) + value.budget > owner.budget)
                    return yield* new Invalid({
                      message: "This request exceeds the organization's remaining model-cost budget.",
                    })
                }
              }
              if (value.parentID && value.budget !== undefined) {
                const parent = yield* tx
                  .select({ budget: Delegation.budget })
                  .from(Delegation)
                  .where(eq(Delegation.id, value.parentID))
                  .get()
                  .pipe(Effect.orDie)
                if (!parent) return yield* new Invalid({ message: "The parent delegation request was not found." })
                if (parent.budget !== null) {
                  const siblings = yield* tx
                    .select()
                    .from(Delegation)
                    .where(eq(Delegation.parent_id, value.parentID))
                    .all()
                    .pipe(Effect.orDie)
                  const allocated = yield* committed(siblings)
                  if (value.budget > parent.budget - allocated)
                    return yield* new Invalid({
                      message: "This delegated follow-on exceeds the parent's remaining delegated-work budget.",
                    })
                }
              }
              if (allocation && value.budget !== undefined) {
                const siblings = yield* (
                  value.parentID
                    ? tx.select().from(Delegation).where(eq(Delegation.parent_id, value.parentID))
                    : tx.select().from(Delegation).where(eq(Delegation.parent_run_id, value.parentRunID!))
                )
                  .all()
                  .pipe(Effect.orDie)
                const reserved = yield* committed(siblings)
                if (allocation.spent + reserved + value.budget > allocation.limit)
                  return yield* new Invalid({
                    message: "This request exceeds the run's remaining model-cost budget.",
                  })
              }
              const now = Date.now()
              const saved = {
                id: key(value.source),
                source: value.source,
                sender_id: value.senderID,
                recipient_id: value.recipientID,
                parent_id: value.parentID ?? null,
                parent_run_id: value.parentRunID ?? null,
                organization_id: organization?.id ?? null,
                organization_name: organization?.name ?? null,
                organization_revision: organization?.revision ?? null,
                workspace: workspace ?? null,
                objective: value.objective,
                expected: value.expected ?? null,
                context: value.context ?? null,
                deadline: value.deadline ?? null,
                budget: value.budget ?? null,
                depth,
                state,
                child_run_id: null,
                session_id: null,
                artifacts: value.artifacts ? JSON.stringify(value.artifacts) : null,
                response: null,
                cost: null,
                reason: reason ?? null,
                time_created: now,
                time_updated: now,
              }
              yield* tx.insert(Delegation).values(saved).run().pipe(Effect.orDie)
              return saved
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      const record = decode(row)
      yield* publish(admission(record, sender, recipient))
      return { record, created: true }
    })
    const accepted = Effect.fn("RayaTaskDelegation.accepted")(function* (recipientID: string) {
      const row = yield* db
        .select()
        .from(Delegation)
        .where(
          and(
            eq(Delegation.recipient_id, recipientID),
            eq(Delegation.state, "accepted"),
            isNotNull(Delegation.child_run_id),
            or(isNull(Delegation.deadline), gt(Delegation.deadline, Date.now())),
          ),
        )
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })
    const take = Effect.fn("RayaTaskDelegation.take")(function* (recipientID: string) {
      const held = yield* accepted(recipientID)
      if (held) return held
      const row = yield* db
        .select()
        .from(Delegation)
        .where(
          and(
            eq(Delegation.recipient_id, recipientID),
            eq(Delegation.state, "queued"),
            or(isNull(Delegation.deadline), gt(Delegation.deadline, Date.now())),
          ),
        )
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      const now = Date.now()
      const runID = crypto.randomUUID()
      const updated = yield* db
        .update(Delegation)
        .set({ state: "accepted", child_run_id: runID, time_updated: now })
        .where(and(eq(Delegation.id, row.id), eq(Delegation.state, "queued")))
        .returning()
        .all()
        .pipe(Effect.orDie)
      return updated[0] ? decode(updated[0]) : undefined
    })
    const authorize = Effect.fn("RayaTaskDelegation.authorize")(function* (row: Record) {
      if (!row.organizationID)
        return shares
          ? yield* shares(row.senderID, row.recipientID).pipe(
              Effect.map((shared) => !shared),
              Effect.catch(() => Effect.succeed(false)),
            )
          : true
      if (!policy) return false
      return yield* policy({
        id: row.organizationID,
        revision: row.organizationRevision,
        senderID: row.senderID,
        recipientID: row.recipientID,
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    })
    const attach = Effect.fn("RayaTaskDelegation.attach")(function* (id: string, runID: string, sessionID: SessionID) {
      const prior = yield* get(id)
      if (prior.childRunID && prior.childRunID !== runID)
        return yield* new Conflict({ message: "This delegation is already attached to another run." })
      if (prior.sessionID && prior.sessionID !== sessionID)
        return yield* new Conflict({ message: "This delegation is already attached to another session." })
      if (prior.childRunID === runID && prior.sessionID === sessionID) {
        yield* begin(prior)
        return prior
      }
      if (prior.state !== "accepted" && prior.state !== "running")
        return yield* new Conflict({ message: "This delegation cannot start from its current state." })
      const now = Date.now()
      yield* db
        .update(Delegation)
        .set({ state: "running", child_run_id: runID, session_id: sessionID, time_updated: now })
        .where(eq(Delegation.id, id))
        .run()
        .pipe(Effect.orDie)
      const record = decode({
        ...(yield* db.select().from(Delegation).where(eq(Delegation.id, id)).get().pipe(Effect.orDie))!,
      })
      yield* begin(record)
      return record
    })
    const finish = Effect.fn("RayaTaskDelegation.finish")(function* (
      id: string,
      state: "completed" | "failed" | "needs_input" | "cancelled",
      recipient: RayaTask.Agent,
      response?: string,
      cost?: number,
      reason?: string,
    ) {
      const prior = yield* get(id)
      const amount = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined
      if (prior.state === "completed" || prior.state === "failed" || prior.state === "cancelled") {
        if (prior.state === state && prior.response === response && prior.cost === amount && prior.reason === reason) {
          yield* reply(prior, recipient)
          return prior
        }
        return yield* new Conflict({ message: "This delegation already has a different result." })
      }
      const now = Date.now()
      const updated = yield* db
        .update(Delegation)
        .set({
          state,
          response: response ?? null,
          cost: amount ?? null,
          reason: reason ?? null,
          time_updated: now,
        })
        .where(and(eq(Delegation.id, id), eq(Delegation.state, prior.state)))
        .returning()
        .all()
        .pipe(Effect.orDie)
      if (!updated[0]) {
        const current = yield* get(id)
        if (
          current.state === state &&
          current.response === response &&
          current.cost === amount &&
          current.reason === reason
        ) {
          yield* reply(current, recipient)
          return current
        }
        return yield* new Conflict({ message: "This delegation already has a different result." })
      }
      const record = decode(updated[0])
      yield* reply(record, recipient)
      return record
    })
    const resume = Effect.fn("RayaTaskDelegation.resume")(function* (id: string, runID: string, sessionID: SessionID) {
      const prior = yield* get(id)
      if (prior.childRunID !== runID || prior.sessionID !== sessionID)
        return yield* new Conflict({ message: "This delegation is attached to another run or session." })
      if (prior.state === "running") return prior
      if (prior.state !== "needs_input")
        return yield* new Conflict({ message: "This delegation is not waiting for a response." })
      const updated = yield* db
        .update(Delegation)
        .set({ state: "running", time_updated: Date.now() })
        .where(and(eq(Delegation.id, id), eq(Delegation.state, "needs_input")))
        .returning()
        .all()
        .pipe(Effect.orDie)
      if (updated[0]) return decode(updated[0])
      const current = yield* get(id)
      if (current.state === "running" && current.childRunID === runID && current.sessionID === sessionID) return current
      return yield* new Conflict({ message: "This delegation changed while its response was being applied." })
    })
    const chain = Effect.fn("RayaTaskDelegation.chain")(function* (id: string) {
      const current = yield* get(id)
      const above = yield* ancestors(current.parentID)
      return [...above.reverse(), current]
    })
    const tree = Effect.fn("RayaTaskDelegation.tree")(function* (id: string) {
      const items = yield* chain(id)
      const record = items[items.length - 1]
      if (!record) return yield* new Invalid({ message: "This delegation request was not found." })
      return { record, above: items.slice(0, -1), below: yield* descendants(id) }
    })
    const descendants = (id: string): Effect.Effect<Record[], Invalid> =>
      Effect.gen(function* () {
        const rows = yield* db.select().from(Delegation).where(eq(Delegation.parent_id, id)).all().pipe(Effect.orDie)
        const items = rows.map(decode)
        const nested: Record[] = []
        for (const item of items) nested.push(...(yield* descendants(item.id)))
        return [...items, ...nested]
      })
    const stop = Effect.fn("RayaTaskDelegation.stop")(function* (
      id: string,
      recipient: RayaTask.Agent,
      reason: string,
      cost?: number,
    ) {
      const prior = yield* get(id)
      if (prior.state === "cancelled") return prior
      if (prior.state === "completed" || prior.state === "failed") return prior
      return yield* finish(id, "cancelled", recipient, undefined, cost, reason)
    })
    const queued = Effect.fn("RayaTaskDelegation.queued")(function* (recipientID: string) {
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(and(eq(Delegation.recipient_id, recipientID), eq(Delegation.state, "queued")))
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })
    const bySession = Effect.fn("RayaTaskDelegation.bySession")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(Delegation)
        .where(eq(Delegation.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })
    const byRun = Effect.fn("RayaTaskDelegation.byRun")(function* (parentRunID: string) {
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(eq(Delegation.parent_run_id, parentRunID))
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })
    const overdue = Effect.fn("RayaTaskDelegation.overdue")(function* (now: number) {
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(and(inArray(Delegation.state, [...live]), isNotNull(Delegation.deadline), lte(Delegation.deadline, now)))
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })
    const held = Effect.fn("RayaTaskDelegation.held")(function* (id: string) {
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(
          and(inArray(Delegation.state, [...live]), or(eq(Delegation.sender_id, id), eq(Delegation.recipient_id, id))),
        )
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })
    const used = Effect.fn("RayaTaskDelegation.used")(function* (id: string) {
      const row = yield* db
        .select({ id: Delegation.id })
        .from(Delegation)
        .where(or(eq(Delegation.sender_id, id), eq(Delegation.recipient_id, id)))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return Boolean(row)
    })
    return {
      admit,
      take,
      accepted,
      authorize,
      attach,
      finish,
      resume,
      get,
      lookup,
      chain,
      tree,
      descendants,
      stop,
      queued,
      overdue,
      bySession,
      byRun,
      held,
      used,
    }
  }
}
