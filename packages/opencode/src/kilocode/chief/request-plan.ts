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

/** Dormant request-bound plan storage. Dispatch remains blocked until exact admission exists. */
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
    const read = Effect.fn("ChiefRequestPlan.read")(function* (id: SessionID, request: MessageID) {
      const raw = yield* storage
        .read<unknown>(key(id, request))
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (raw === undefined) return
      return yield* Schema.decodeUnknownEffect(Record)(raw).pipe(
        Effect.mapError(() => new Error("Chief request plan is unreadable")),
      )
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

    return { active: (id: SessionID) => active(storage, id), read, start }
  }
}
