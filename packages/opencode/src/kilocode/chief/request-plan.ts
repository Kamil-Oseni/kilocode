import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Permission } from "@/permission"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { mutation } from "@/kilocode/goal/mutation"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefPlan } from "@/kilocode/chief/plan"
import { durable, stopped } from "@/kilocode/task/owner"

/** Dormant request-bound plan storage and exact read-only branch admission. */
export namespace ChiefRequestPlan {
  const Identity = Schema.Struct({
    version: Schema.Literal(1),
    sessionID: SessionID,
    requestID: MessageID,
    userCreatedAt: Schema.Number,
    digest: Schema.String,
    revision: Schema.String,
  })
  export type Identity = typeof Identity.Type

  const Marker = Schema.Struct({ version: Schema.Literal(1), identity: Identity })
  const Record = Schema.Struct({
    version: Schema.Literal(3),
    identity: Identity,
    createdAt: Schema.Number,
    branches: Schema.Array(ChiefBranches.Branch).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
  })
  export type Record = typeof Record.Type

  const marker = (id: SessionID) => ["raya", "chief", "request-plan", id, "active"]
  const key = (id: SessionID, request: MessageID) => ["raya", "chief", "request-plan", id, request]
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")

  export const active = Effect.fn("ChiefRequestPlan.active")(function* (
    storage: Pick<Storage.Interface, "read">,
    id: SessionID,
  ) {
    const raw = yield* storage
      .read<unknown>(marker(id))
      .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (raw === undefined) return
    return yield* Schema.decodeUnknownEffect(Marker)(raw).pipe(
      Effect.mapError(() => new Error("Active Chief request plan marker is unreadable")),
    )
  })

  export function make(
    storage: Pick<Storage.Interface, "read" | "create" | "replace" | "remove">,
    sessions: Pick<Session.Interface, "get" | "messages">,
  ) {
    const exact = Effect.fn("ChiefRequestPlan.exact")(function* (id: SessionID, identity: Identity) {
      const session = yield* sessions.get(id)
      if (RayaChief.phase(session.metadata) !== "task") throw new Error("Chief request plan is outside the task phase")
      const rows = yield* sessions.messages({ sessionID: id })
      // Session.messages returns ascending (createdAt, ID) order across pages.
      const latest = rows.filter((row) => row.info.role === "user" && RayaChief.requestText(row.parts)).at(-1)
      if (!latest || latest.info.role !== "user" || latest.info.id !== identity.requestID)
        throw new Error("Chief request plan no longer matches the latest authored user message")
      const request = RayaChief.requestText(latest.parts)
      if (!request || RayaChief.request(session.metadata) !== request)
        throw new Error("Chief request plan objective differs from the saved user request")
      if (
        identity.sessionID !== id ||
        identity.userCreatedAt !== latest.info.time.created ||
        identity.digest !== hash(request) ||
        identity.revision !== hash(JSON.stringify([id, identity.requestID, latest.info.time.created, request]))
      )
        throw new Error("Chief request plan identity changed")
      return identity
    })

    const read = Effect.fn("ChiefRequestPlan.read")(function* (id: SessionID, request: MessageID) {
      const raw = yield* storage
        .read<unknown>(key(id, request))
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (raw === undefined) return
      return yield* Schema.decodeUnknownEffect(Record)(raw).pipe(
        Effect.mapError(() => new Error("Chief request plan is unreadable")),
      )
    })

    const saved = Effect.fn("ChiefRequestPlan.saved")(function* (id: SessionID) {
      const marker = yield* active(storage, id)
      if (!marker) return
      const record = yield* read(id, marker.identity.requestID)
      if (!record || JSON.stringify(record.identity) !== JSON.stringify(marker.identity))
        throw new Error("Chief request plan is incomplete or changed")
      return record
    })

    const load = Effect.fn("ChiefRequestPlan.load")(function* (id: SessionID) {
      const record = yield* saved(id)
      if (!record) return
      yield* exact(id, record.identity)
      return record
    })

    const start = Effect.fn("ChiefRequestPlan.start")(function* (input: {
      sessionID: SessionID
      requestID: MessageID
      proposals: unknown
      agents: readonly ChiefPlan.Agent[]
      parent: Permission.Ruleset
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const session = yield* sessions.get(input.sessionID)
          if (RayaChief.phase(session.metadata) !== "task")
            throw new Error("Only a routed request can save a Chief request plan")
          const rows = yield* sessions.messages({ sessionID: input.sessionID })
          // Session.messages returns ascending (createdAt, ID) order across pages.
          const latest = rows.filter((row) => row.info.role === "user" && RayaChief.requestText(row.parts)).at(-1)
          if (!latest || latest.info.role !== "user" || latest.info.id !== input.requestID)
            throw new Error("Chief request plan no longer matches the latest authored user message")
          const request = RayaChief.requestText(latest.parts)
          if (!request || RayaChief.request(session.metadata) !== request)
            throw new Error("Chief request plan objective differs from the saved user request")
          const identity: Identity = {
            version: 1,
            sessionID: input.sessionID,
            requestID: input.requestID,
            userCreatedAt: latest.info.time.created,
            digest: hash(request),
            revision: hash(JSON.stringify([input.sessionID, input.requestID, latest.info.time.created, request])),
          }
          const branches = ChiefPlan.validate({
            request,
            proposals: input.proposals,
            agents: input.agents,
            parent: input.parent,
          })
          if (branches.some((branch) => branch.access !== "read"))
            throw new Error("Request-bound Chief plans currently allow read-only branches only")
          const goalPlan = yield* ChiefBranches.make(storage).read(input.sessionID)
          if (goalPlan) {
            const goal = yield* storage
              .read<{
                createdAt?: number
                status?: string
                revisions?: { id?: string }[]
              }>(["raya", "goal", input.sessionID])
              .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
            if (ChiefBranches.matches(goalPlan, goal))
              throw new Error("An active goal-bound Chief plan already owns this session")
          }
          const current = yield* active(storage, input.sessionID)
          if (current && current.identity.revision !== identity.revision)
            throw new Error("Another Chief request plan already owns this session")
          const old = yield* read(input.sessionID, input.requestID)
          if (current || old) {
            if (
              current?.identity.revision === identity.revision &&
              old?.identity.revision === identity.revision &&
              JSON.stringify(old.branches.map(({ state, updatedAt, ...branch }) => branch)) === JSON.stringify(branches)
            )
              return old
            throw new Error("Chief request plan outcome is already saved or uncertain")
          }
          const now = Date.now()
          const plan: Record = {
            version: 3,
            identity,
            createdAt: now,
            branches: branches.map((branch) => ({ ...branch, state: "planned", updatedAt: now })),
          }
          // A crash between these writes leaves a blocking marker. It never enables unbound dispatch.
          yield* storage.create(marker(input.sessionID), { version: 1, identity } satisfies typeof Marker.Type)
          yield* storage.create(key(input.sessionID, input.requestID), plan)
          return plan
        }),
      )
    })

    const reserve = Effect.fn("ChiefRequestPlan.reserve")(function* (input: {
      sessionID: SessionID
      requestID: MessageID
      revision: string
      branchID: string
      callID: string
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const record = yield* load(input.sessionID)
          if (!record || record.identity.requestID !== input.requestID || record.identity.revision !== input.revision)
            throw new Error("Chief request plan changed before reservation")
          if (!input.callID.trim()) throw new Error("Chief request branch needs an exact call ID")
          const branch = record.branches.find((item) => item.id === input.branchID)
          if (!branch || branch.access !== "read" || branch.state !== "planned")
            throw new Error("Chief request branch is unavailable or already reserved")
          if (record.branches.some((item) => item.callID === input.callID))
            throw new Error("Chief request call ID already belongs to a branch")
          const next: ChiefBranches.Branch = {
            ...branch,
            state: "admitted",
            callID: input.callID,
            owner: durable(),
            updatedAt: Date.now(),
          }
          yield* storage.replace(key(input.sessionID, input.requestID), {
            ...record,
            branches: record.branches.map((item) => (item.id === branch.id ? next : item)),
          } satisfies Record)
          return next
        }),
      )
    })

    const admit = Effect.fn("ChiefRequestPlan.admit")(function* (input: {
      sessionID: SessionID
      requestID: MessageID
      revision: string
      branchID: string
      callID: string
      childID: SessionID
      messageID: MessageID
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const record = yield* load(input.sessionID)
          if (!record || record.identity.requestID !== input.requestID || record.identity.revision !== input.revision)
            throw new Error("Chief request plan changed before admission")
          const branch = record.branches.find((item) => item.id === input.branchID)
          if (!branch || branch.state !== "admitted" || branch.callID !== input.callID || branch.sessionID)
            throw new Error("Chief request branch reservation is missing or already bound")
          if (record.branches.some((item) => item.sessionID === input.childID))
            throw new Error("Chief request child already belongs to a branch")
          const next: ChiefBranches.Branch = {
            ...branch,
            sessionID: input.childID,
            messageID: input.messageID,
            updatedAt: Date.now(),
          }
          yield* storage.replace(key(input.sessionID, input.requestID), {
            ...record,
            branches: record.branches.map((item) => (item.id === branch.id ? next : item)),
          } satisfies Record)
          return next
        }),
      )
    })

    const settle = Effect.fn("ChiefRequestPlan.settle")(function* (input: {
      sessionID: SessionID
      requestID: MessageID
      revision: string
      branchID: string
      callID: string
      childID: SessionID
      messageID: MessageID
      state: "completed" | "failed" | "cancelled" | "unknown"
      result: string
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const record = yield* saved(input.sessionID)
          if (!record || record.identity.requestID !== input.requestID || record.identity.revision !== input.revision)
            throw new Error("Chief request plan changed before settlement")
          const branch = record.branches.find((item) => item.id === input.branchID)
          if (
            !branch ||
            branch.state !== "admitted" ||
            branch.callID !== input.callID ||
            branch.sessionID !== input.childID ||
            branch.messageID !== input.messageID
          )
            throw new Error("Chief request branch lineage changed before settlement")
          const next: ChiefBranches.Branch = {
            ...branch,
            state: input.state,
            result: input.result,
            updatedAt: Date.now(),
          }
          yield* storage.replace(key(input.sessionID, input.requestID), {
            ...record,
            branches: record.branches.map((item) => (item.id === branch.id ? next : item)),
          } satisfies Record)
          return next
        }),
      )
    })

    const reconcile = Effect.fn("ChiefRequestPlan.reconcile")(function* (id: SessionID) {
      return yield* mutation(
        storage,
        id,
        Effect.gen(function* () {
          const record = yield* saved(id)
          if (!record) return
          const stale = record.branches.filter((branch) => branch.state === "admitted" && stopped(branch.owner))
          if (!stale.length) return record
          const next: Record = {
            ...record,
            branches: record.branches.map((branch) =>
              stale.includes(branch)
                ? {
                    ...branch,
                    state: "unknown" as const,
                    updatedAt: Date.now(),
                    result: "Owner ended before the result was verified.",
                  }
                : branch,
            ),
          }
          yield* storage.replace(key(id, record.identity.requestID), next)
          return next
        }),
      )
    })

    return { active: (id: SessionID) => active(storage, id), read, load, start, reserve, admit, settle, reconcile }
  }
}
