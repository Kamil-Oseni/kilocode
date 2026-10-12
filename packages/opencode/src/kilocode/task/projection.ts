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
    status: Schema.Literals(["queued", "running", "complete", "blocked", "error"]),
    at: Codec.Timestamp,
    summary: Schema.String.check(Schema.isMaxLength(8000)),
    delivery: Schema.Literals(["delivered", "unavailable"]),
    notice: Schema.optional(Schema.Struct({ at: Codec.Timestamp, reason: Schema.Literals(["busy", "deferred"]) })),
  })
  export type Card = typeof Card.Type
  export const Changed = BusEvent.define("raya.routine.report.changed", Schema.Struct({ card: Card }))

  const prefix = ["raya", "routine-reports"]
  const key = (id: string) => [...prefix, createHash("sha256").update(id).digest("hex")]
  const decode = Schema.decodeUnknownEffect(Card)

  export function make(input: {
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get">
    scope?: { projectID: string; directory: string }
  }) {
    const lookup = (id: SessionID) => input.sessions.get(id).pipe(Effect.option)
    const same = (left: { projectID: string; directory: string }, right: { projectID: string; directory: string }) =>
      left.projectID === right.projectID && path.resolve(left.directory) === path.resolve(right.directory)
    const read = (id: string) =>
      input.storage.readBounded<unknown>(key(id), 40 * 1024).pipe(
        Effect.flatMap(decode),
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      )
    type Input = {
      agent: Codec.Agent
      id: string
      run?: Codec.Run
      at: number
      summary: string
      notice?: Card["notice"]
    }
    const publish = Effect.fn("RayaRoutineReports.publish")(function* (value: Input) {
      if (value.run && value.agent.id !== value.run.agentID)
        return yield* Effect.fail(new Error("Report worker identity changed."))
      const prior = yield* read(value.id)
      if (prior && prior.agentID !== value.agent.id)
        return yield* Effect.fail(new Error("Report run identity belongs to another worker."))
      if (prior?.runID && !value.run) return prior
      if (prior?.runID && value.run && prior.runID !== value.run.id)
        return yield* Effect.fail(new Error("This occurrence already belongs to another run."))
      if (prior?.runRevision && value.run && prior.runRevision > (value.run.revision ?? 1)) return prior
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
        status: replay ? prior!.status : (value.run?.status ?? "queued"),
        at: replay || (prior?.notice && !value.run && !value.notice) ? prior!.at : value.at,
        summary:
          replay || (prior?.notice && !value.run && !value.notice) ? prior!.summary : value.summary.slice(0, 8000),
        delivery,
        notice: prior?.notice ?? value.notice,
      }
      const saved = yield* decode(JSON.parse(JSON.stringify(card)))
      if (isDeepStrictEqual(prior, saved)) return prior
      const next = yield* decode({ ...saved, revision: (prior?.revision ?? 0) + 1 })
      yield* input.storage.replace(key(value.id), next)
      GlobalBus.emit("event", {
        directory: next.directory,
        project: next.projectID,
        payload: { type: Changed.type, properties: { card: next } },
      })
      return next
    })
    return {
      publish: (value: { agent: Codec.Agent; run: Codec.Run; occurrenceID?: string }) =>
        mutate(
          input.storage,
          publish({
            ...value,
            id: value.occurrenceID ?? value.run.id,
            at: value.run.at,
            summary: value.run.outcome?.summary ?? value.run.blockedReason ?? "",
          }),
          "Routine report",
        ),
      publishDeferred: (value: {
        agent: Codec.Agent
        id: string
        at: number
        summary: string
        notice?: Card["notice"]
      }) => mutate(input.storage, publish(value), "Routine report"),
      list: Effect.fn("RayaRoutineReports.list")(function* (id: SessionID) {
        const target = yield* input.sessions.get(id)
        const scope =
          input.scope ??
          (yield* InstanceState.context.pipe(
            Effect.map((ctx) => ({ projectID: ctx.project.id, directory: ctx.directory })),
          ))
        if (!same(scope, target))
          return yield* Effect.fail(new Error("This report conversation belongs to another workspace."))
        if (target.metadata?.rayaRoutine) return []
        const items: Card[] = []
        const entries = yield* input.storage.list(prefix)
        if (entries.length > 500)
          return yield* Effect.fail(
            new Error(
              "Routine report history exceeds this view's bounded scan. Archive older reports before retrying.",
            ),
          )
        for (const entry of entries) {
          const card = yield* input.storage.readBounded<unknown>(entry, 40 * 1024).pipe(Effect.flatMap(decode))
          if (card.reportSessionID === id && same(card, target)) items.push(card)
        }
        return items.toSorted((a, b) => b.at - a.at).slice(0, 200)
      }),
    }
  }
}
