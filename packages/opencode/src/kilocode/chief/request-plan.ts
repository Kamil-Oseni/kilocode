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
  const Rotation = Schema.Struct({
    version: Schema.Literal(1),
    prior: Identity,
    next: Identity,
    at: Schema.Number,
  })
  export type Rotation = typeof Rotation.Type
  const Record = Schema.Struct({
    version: Schema.Literal(3),
    identity: Identity,
    createdAt: Schema.Number,
    branches: Schema.Array(ChiefBranches.Branch).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
    synthesis: Schema.optional(
      Schema.Struct({
        version: Schema.Literal(1),
        summary: Schema.String,
        findings: Schema.Array(Schema.Struct({ branchID: Schema.String, conclusion: Schema.String })),
        at: Schema.Number,
      }),
    ),
  })
  export type Record = typeof Record.Type

  const marker = (id: SessionID) => ["raya", "chief", "request-plan", id, "active"]
  export const key = (id: SessionID, request: MessageID) => ["raya", "chief", "request-plan", id, request]
  const rotated = (id: SessionID, request: MessageID) => ["raya", "chief", "request-plan", id, request, "rotation"]
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

    const readRotation = Effect.fn("ChiefRequestPlan.readRotation")(function* (id: SessionID, request: MessageID) {
      const raw = yield* storage
        .read<unknown>(rotated(id, request))
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (raw === undefined) return
      return yield* Schema.decodeUnknownEffect(Rotation)(raw).pipe(
        Effect.mapError(() => new Error("Chief request plan rotation receipt is unreadable")),
      )
    })

    const saved = Effect.fn("ChiefRequestPlan.saved")(function* (id: SessionID) {
      const marker = yield* active(storage, id)
      if (!marker) return
      const record = yield* read(id, marker.identity.requestID)
      if (!record || JSON.stringify(record.identity) !== JSON.stringify(marker.identity))
        throw new Error("Chief request plan is incomplete or changed")
      const ids = record.branches.map((branch) => branch.id)
      const calls = record.branches.flatMap((branch) => (branch.callID ? [branch.callID] : []))
      const children = record.branches.flatMap((branch) => (branch.sessionID ? [branch.sessionID] : []))
      if (
        record.branches.some(
          (branch) =>
            branch.access !== "read" ||
            (branch.state === "planned" && (branch.callID || branch.sessionID || branch.messageID)) ||
            (branch.state === "admitted" && !branch.callID) ||
            (branch.state === "completed" && (!branch.callID || !branch.sessionID || !branch.messageID)),
        ) ||
        new Set(ids).size !== ids.length ||
        new Set(calls).size !== calls.length ||
        new Set(children).size !== children.length
      )
        throw new Error("Chief request plan has inconsistent branch authority or lineage")
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
          const prior = rows.filter((row) => row.info.role === "user" && row.info.id !== input.requestID).reverse()
          for (const row of prior) {
            const plan = yield* read(input.sessionID, row.info.id)
            const receipt = yield* readRotation(input.sessionID, row.info.id)
            if (!plan && !receipt) continue
            const target = rows.find((item) => item.info.role === "user" && item.info.id === receipt?.next.requestID)
            const text = target ? RayaChief.requestText(target.parts) : ""
            if (
              !plan ||
              !receipt ||
              JSON.stringify(receipt.prior) !== JSON.stringify(plan.identity) ||
              !target ||
              target.info.role !== "user" ||
              !text ||
              rows.indexOf(target) <= rows.indexOf(row) ||
              rows.indexOf(target) > rows.indexOf(latest) ||
              receipt.next.sessionID !== input.sessionID ||
              receipt.next.userCreatedAt !== target.info.time.created ||
              receipt.next.digest !== hash(text) ||
              receipt.next.revision !==
                hash(JSON.stringify([input.sessionID, target.info.id, target.info.time.created, text]))
            )
              throw new Error("Prior Chief request plan has no exact terminal rotation receipt")
            break
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

    /** Retire only a fully reviewed and synthesized request before admitting a later authored request. */
    const rotate = Effect.fn("ChiefRequestPlan.rotate")(function* (input: {
      sessionID: SessionID
      priorRequestID: MessageID
      nextRequestID: MessageID
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const session = yield* sessions.get(input.sessionID)
          if (RayaChief.phase(session.metadata) !== "task")
            throw new Error("Chief request rotation requires a routed task phase")
          const rows = yield* sessions.messages({ sessionID: input.sessionID })
          const authored = rows.filter((row) => row.info.role === "user" && RayaChief.requestText(row.parts))
          const latest = authored.at(-1)
          const prior = authored.find((row) => row.info.id === input.priorRequestID)
          if (
            !latest ||
            latest.info.role !== "user" ||
            latest.info.id !== input.nextRequestID ||
            !prior ||
            prior.info.role !== "user" ||
            authored.indexOf(prior) >= authored.length - 1
          )
            throw new Error("Chief request rotation needs a strictly later authored user request")
          const request = RayaChief.requestText(latest.parts)
          if (RayaChief.request(session.metadata) !== request)
            throw new Error("Chief request rotation does not match the routed new request")
          const next: Identity = {
            version: 1,
            sessionID: input.sessionID,
            requestID: latest.info.id,
            userCreatedAt: latest.info.time.created,
            digest: hash(request),
            revision: hash(JSON.stringify([input.sessionID, latest.info.id, latest.info.time.created, request])),
          }
          const current = yield* active(storage, input.sessionID)
          const receipt = yield* readRotation(input.sessionID, input.priorRequestID)
          if (!current) {
            const plan = yield* read(input.sessionID, input.priorRequestID)
            if (
              receipt &&
              plan &&
              JSON.stringify(receipt.prior) === JSON.stringify(plan.identity) &&
              JSON.stringify(receipt.next) === JSON.stringify(next)
            )
              return receipt
            throw new Error("No active Chief request plan or matching rotation receipt")
          }
          if (current.identity.requestID !== input.priorRequestID)
            throw new Error("Another Chief request plan owns this session")
          const record = yield* read(input.sessionID, input.priorRequestID)
          if (!record) throw new Error("Marker-only Chief request plan cannot rotate without branch-state proof")
          const plan = yield* saved(input.sessionID)
          if (!plan) throw new Error("Chief request plan is unavailable for rotation")
          const old = prior.info.time.created
          const text = RayaChief.requestText(prior.parts)
          if (
            plan.identity.userCreatedAt !== old ||
            plan.identity.digest !== hash(text) ||
            plan.identity.revision !== hash(JSON.stringify([input.sessionID, input.priorRequestID, old, text]))
          )
            throw new Error("Prior authored request changed before rotation")
          if (
            plan.branches.some(
              (branch) =>
                branch.state !== "completed" ||
                !branch.review ||
                !branch.callID ||
                !branch.sessionID ||
                !branch.messageID,
            ) ||
            !plan.synthesis ||
            plan.synthesis.findings.length !== plan.branches.length ||
            new Set(plan.synthesis.findings.map((item) => item.branchID)).size !== plan.branches.length ||
            plan.branches.some(
              (branch) =>
                !plan.synthesis?.findings.some((item) => item.branchID === branch.id && !!item.conclusion.trim()),
            )
          )
            throw new Error("Chief request plan has unresolved or unsynthesized branches")
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
              throw new Error("Active goal-bound Chief plan prevents request rotation")
          }
          if (receipt && (receipt.prior.revision !== plan.identity.revision || receipt.next.revision !== next.revision))
            throw new Error("Chief request rotation receipt belongs to another request")
          const savedReceipt: Rotation = receipt ?? { version: 1, prior: plan.identity, next, at: Date.now() }
          if (!receipt) yield* storage.create(rotated(input.sessionID, input.priorRequestID), savedReceipt)
          const confirmed = yield* readRotation(input.sessionID, input.priorRequestID)
          if (JSON.stringify(confirmed) !== JSON.stringify(savedReceipt))
            throw new Error("Chief request rotation receipt outcome is unknown")
          yield* storage.remove(marker(input.sessionID))
          if (yield* active(storage, input.sessionID))
            throw new Error("Chief request marker removal outcome is unknown")
          return savedReceipt
        }),
      )
    })

    return {
      active: (id: SessionID) => active(storage, id),
      read,
      saved,
      load,
      start,
      reserve,
      admit,
      settle,
      reconcile,
      readRotation,
      rotate,
    }
  }
}
