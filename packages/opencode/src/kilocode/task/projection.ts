import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Codec } from "./schema"
import { mutate } from "./mutation"
import { InstanceState } from "@/effect/instance-state"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { isDeepStrictEqual } from "node:util"
import { history } from "./report-history"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineOccurrenceTable as Occurrence } from "@opencode-ai/core/kilocode/routine.sql"
import { eq } from "drizzle-orm"

export namespace RayaRoutineReports {
  export const Card = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    runID: Schema.optional(Schema.String),
    agentID: Schema.String,
    name: Schema.String,
    sourceSessionID: Schema.optional(SessionID),
    reportSessionID: SessionID,
    workerSessionID: Schema.optional(SessionID),
    projectID: Schema.String,
    directory: Schema.String,
    revision: Codec.Version,
    runRevision: Schema.optional(Codec.Version),
    status: Schema.Literals(["queued", "running", "complete", "blocked", "error", "stopped"]),
    at: Codec.Timestamp,
    summary: Schema.String.check(Schema.isMaxLength(8000)),
    delivery: Schema.Literals(["delivered", "unavailable"]),
    notice: Schema.optional(Schema.Struct({ at: Codec.Timestamp, reason: Schema.Literals(["busy", "deferred"]) })),
  })
  export type Card = typeof Card.Type
  export const Page = Schema.Struct({
    items: Schema.Array(Card),
    next: Schema.optional(Schema.String),
    bootstrap: Schema.optional(Schema.Struct({ complete: Schema.Boolean, scanned: Schema.Int, total: Schema.Int })),
  })
  export type Page = typeof Page.Type
  export const Changed = BusEvent.define("raya.routine.report.changed", Schema.Struct({ card: Card }))

  const prefix = ["raya", "routine-reports"]
  const key = (id: string) => [...prefix, createHash("sha256").update(id).digest("hex")]
  const decode = Schema.decodeUnknownEffect(Card)

  export function make(input: {
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get">
    database?: Database.Interface
    scope?: { projectID: string; directory: string }
  }) {
    const index = history(input.storage, decode)
    const lookup = (id: SessionID) => input.sessions.get(id).pipe(Effect.option)
    const same = (left: { projectID: string; directory: string }, right: { projectID: string; directory: string }) =>
      left.projectID === right.projectID && path.resolve(left.directory) === path.resolve(right.directory)
    const read = (id: string) =>
      input.storage.readBounded<unknown>(key(id), 40 * 1024).pipe(
        Effect.flatMap(decode),
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      )
    const save = Effect.fn("RayaRoutineReports.save")(function* (card: Card) {
      yield* input.storage.replace(key(card.id), card)
      yield* index.upsert(card)
      GlobalBus.emit("event", {
        directory: card.directory,
        project: card.projectID,
        payload: { type: Changed.type, properties: { card } },
      })
      return card
    })
    type Input = {
      agent: Codec.Agent
      id: string
      run?: Codec.Run
      at: number
      summary: string
      notice?: Card["notice"]
      status?: Card["status"]
    }
    const publish = Effect.fn("RayaRoutineReports.publish")(function* (value: Input) {
      if (value.run && value.agent.id !== value.run.agentID)
        return yield* Effect.fail(new Error("Report worker identity changed."))
      const prior = yield* read(value.id)
      if (prior && prior.agentID !== value.agent.id)
        return yield* Effect.fail(new Error("Report run identity belongs to another worker."))
      if (prior?.runID && !value.run) {
        yield* index.upsert(prior)
        return prior
      }
      if (prior && prior.status !== "queued" && (!value.run || !prior.runID)) {
        yield* index.upsert(prior)
        return prior
      }
      if (prior?.runID && value.run && prior.runID !== value.run.id)
        return yield* Effect.fail(new Error("This occurrence already belongs to another run."))
      if (prior?.runRevision && value.run && prior.runRevision > (value.run.revision ?? 1)) {
        yield* index.upsert(prior)
        return prior
      }
      const source = prior ? prior.sourceSessionID : value.agent.sourceSessionID
      const destination = prior?.reportSessionID ?? value.agent.reportSessionID ?? source
      if (!destination) return undefined
      const replay = !!prior?.runRevision && prior.runRevision === (value.run?.revision ?? 1)
      const target = yield* lookup(destination)
      const origin =
        prior ??
        (source
          ? Option.getOrUndefined(yield* lookup(source))
          : yield* Effect.gen(function* () {
              const scope =
                input.scope ??
                (yield* InstanceState.context.pipe(
                  Effect.map((ctx) => ({ projectID: ctx.project.id, directory: ctx.directory })),
                ))
              return target._tag === "Some" && same(scope, target.value) ? target.value : undefined
            }))
      const delivery =
        origin && target._tag === "Some" && same(origin, target.value) && !target.value.metadata?.rayaRoutine
          ? ("delivered" as const)
          : ("unavailable" as const)
      const card: Card = {
        version: 1,
        id: value.id,
        runID: value.run?.id,
        agentID: value.agent.id,
        name: prior?.name ?? value.agent.name,
        sourceSessionID: source,
        reportSessionID: destination,
        workerSessionID: replay ? prior?.workerSessionID : value.run?.sessionID,
        projectID: origin?.projectID ?? "",
        directory: origin?.directory ?? "",
        revision: prior?.revision ?? 1,
        runRevision: value.run?.revision ?? (value.run ? 1 : undefined),
        status: replay ? prior.status : (value.run?.status ?? value.status ?? "queued"),
        at:
          replay || (prior?.notice && !value.run && !value.notice && (!value.status || value.status === "queued"))
            ? prior.at
            : value.at,
        summary:
          replay || (prior?.notice && !value.run && !value.notice && (!value.status || value.status === "queued"))
            ? prior.summary
            : value.summary.slice(0, 8000),
        delivery,
        notice: prior?.notice ?? value.notice,
      }
      const saved = yield* decode(JSON.parse(JSON.stringify(card)))
      if (isDeepStrictEqual(prior, saved)) {
        yield* index.upsert(saved)
        return prior
      }
      const next = yield* decode({ ...saved, revision: (prior?.revision ?? 0) + 1 })
      return yield* save(next)
    })
    const reconcile = Effect.fn("RayaRoutineReports.reconcile")(function* (card: Card, target: Session.Info) {
      const database = input.database
      if (!database || card.status !== "queued" || card.runID || card.workerSessionID) return card
      return yield* mutate(
        input.storage,
        Effect.gen(function* () {
          const current = yield* read(card.id)
          if (!current || current.id !== card.id)
            return yield* Effect.fail(new Error("Routine report identity changed during reconciliation."))
          if (current.reportSessionID !== target.id || !same(current, target)) return undefined
          const destination = yield* lookup(target.id)
          if (
            destination._tag === "None" ||
            destination.value.metadata?.rayaRoutine ||
            !same(current, destination.value)
          )
            return undefined
          if (current.status !== "queued" || current.runID || current.workerSessionID) return current
          const row = yield* database.db.select().from(Occurrence).where(eq(Occurrence.id, current.id)).get()
          if (
            !row ||
            row.agent_id !== current.agentID ||
            row.state !== "skipped" ||
            row.claim_id !== null ||
            row.session_id !== null ||
            current.id !== `timer:${JSON.stringify([row.agent_id, row.schedule_version, row.scheduled_at])}`
          )
            return current
          return yield* save(
            yield* decode({
              ...current,
              status: "stopped",
              summary: (row.reason ?? "This scheduled occurrence was skipped before startup.").slice(0, 8000),
              revision: current.revision + 1,
            }),
          )
        }),
        "Routine report",
      )
    })
    const page = Effect.fn("RayaRoutineReports.page")(function* (query: {
      sessionID: SessionID
      cursor?: string
      limit?: number
    }) {
      const target = yield* input.sessions.get(query.sessionID)
      const scope =
        input.scope ??
        (yield* InstanceState.context.pipe(
          Effect.map((ctx) => ({ projectID: ctx.project.id, directory: ctx.directory })),
        ))
      if (!same(scope, target))
        return yield* Effect.fail(new Error("This report conversation belongs to another workspace."))
      if (target.metadata?.rayaRoutine) {
        const empty: Page = { items: [], bootstrap: { complete: true, scanned: 0, total: 0 } }
        return empty
      }
      const bootstrap = yield* mutate(input.storage, index.bootstrap(), "Routine report history")
      const result = yield* index.page(query)
      const cards = yield* Effect.forEach(
        result.items.filter((card) => same(card, target)),
        (card) => reconcile(card, target),
        { concurrency: 1 },
      )
      const response: Page = {
        ...result,
        items: cards.filter((card): card is Card => card !== undefined),
        bootstrap: { complete: bootstrap.complete, scanned: bootstrap.scanned, total: bootstrap.total },
      }
      return response
    })
    return {
      page,
      publish: (value: { agent: Codec.Agent; run: Codec.Run; occurrenceID?: string; delegationID?: string }) =>
        mutate(
          input.storage,
          Effect.gen(function* () {
            const legacy =
              value.delegationID && !(yield* read(value.delegationID)) ? yield* read(value.run.id) : undefined
            return yield* publish({
              ...value,
              id: value.occurrenceID ?? (legacy ? value.run.id : value.delegationID) ?? value.run.id,
              at: value.run.at,
              summary: value.run.outcome?.summary ?? value.run.blockedReason ?? "",
            })
          }),
          "Routine report",
        ),
      publishDeferred: (value: {
        agent: Codec.Agent
        id: string
        at: number
        summary: string
        notice?: Card["notice"]
        status?: Card["status"]
      }) => mutate(input.storage, publish(value), "Routine report"),
      list: (sessionID: SessionID) => page({ sessionID }).pipe(Effect.map((result) => result.items)),
    }
  }
}
