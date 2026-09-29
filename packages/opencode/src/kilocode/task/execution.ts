import { createHash } from "node:crypto"
import { Context, Effect, Exit, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type { SessionID } from "@/session/schema"
import { RayaTask } from "."
import { durable, stopped } from "./owner"
import { read } from "./storage-read"
import { mutate } from "./mutation"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Owner = Schema.Struct({
  host: Name,
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  birth: Name,
})
const Record = Schema.Struct({
  version: Schema.Literal(1),
  agentID: Name,
  runID: Name,
  sessionID: Name,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  owner: Owner,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
})
type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
type Permit = { record: typeof Record.Type }
type Capability = { token: string; agentID: string; runID: string; sessionID: string; fiber: unknown }
const Current = Context.Reference<Capability | undefined>("@raya/RoutineExecution", { defaultValue: () => undefined })
const active = new Set<string>()
const busy = new Set<string>()
const closing = new Set<string>()
const hash = (id: string) => createHash("sha256").update(id).digest("hex")
const key = (id: string) => ["raya", "agent-executions", hash(id)]
const same = (left: typeof Owner.Type, right: typeof Owner.Type) =>
  left.host === right.host && left.pid === right.pid && left.birth === right.birth

export namespace RayaTaskExecution {
  /** Own one exact continuing run. Foreign or uncertain live work always fails closed. */
  export function make(storage: Store) {
    const load = (id: string) =>
      read(storage, key(id)).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.succeed(undefined)
            : Schema.decodeUnknownEffect(Record)(value).pipe(
                Effect.mapError(
                  () => new RayaTask.GuardError({ message: "This routine's execution owner needs recovery review." }),
                ),
              ),
        ),
      )

    const acquire = Effect.fn("RayaTaskExecution.acquire")(function* (run: {
      id: string
      agentID: string
      sessionID: SessionID
    }) {
      const found = durable()
      if (!found.birth)
        return yield* new RayaTask.GuardError({
          message: "This backend cannot prove its process identity for continuing routine work.",
        })
      const identity = { ...found, birth: found.birth }
      const result = yield* mutate(
        storage,
        Effect.gen(function* () {
          const prior = yield* load(run.id)
          if (prior) {
            if (prior.agentID !== run.agentID || prior.runID !== run.id || prior.sessionID !== run.sessionID)
              return yield* new RayaTask.GuardError({
                message: "This routine's saved execution identity is inconsistent and needs recovery review.",
              })
            if (same(prior.owner, identity)) {
              if (active.has(prior.token))
                return busy.has(prior.token) ? undefined : ({ record: prior } satisfies Permit)
              return yield* new RayaTask.GuardError({
                message: "This routine's execution outcome is uncertain and needs recovery review.",
              })
            }
            if (!stopped(prior.owner))
              return yield* new RayaTask.GuardError({
                message: "This routine is still owned by another backend or needs recovery review.",
              })
          }
          const now = Date.now()
          const record: typeof Record.Type = {
            version: 1,
            agentID: run.agentID,
            runID: run.id,
            sessionID: run.sessionID,
            token: crypto.randomUUID(),
            owner: identity,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
          }
          if (prior) yield* storage.replace(key(run.id), record).pipe(Effect.orDie)
          else if (!(yield* storage.create(key(run.id), record).pipe(Effect.orDie)))
            return yield* Effect.die(new Error("Routine execution ownership changed during admission."))
          return { record } satisfies Permit
        }),
        "Routine execution",
      )
      if (result) active.add(result.record.token)
      return result
    })

    const heartbeat = Effect.fn("RayaTaskExecution.heartbeat")(function* (permit: Permit) {
      yield* mutate(
        storage,
        Effect.gen(function* () {
          const current = yield* load(permit.record.runID)
          if (
            !current ||
            current.token !== permit.record.token ||
            !same(current.owner, permit.record.owner) ||
            current.agentID !== permit.record.agentID ||
            current.sessionID !== permit.record.sessionID
          )
            return yield* new RayaTask.GuardError({
              message: "This routine lost its exact execution ownership.",
            })
          yield* storage.replace(key(current.runID), { ...current, updatedAt: Date.now() }).pipe(Effect.orDie)
        }),
        "Routine execution heartbeat",
      )
    })

    const release = Effect.fn("RayaTaskExecution.release")(function* (permit: Permit) {
      yield* mutate(
        storage,
        Effect.gen(function* () {
          const current = yield* load(permit.record.runID)
          if (!current) return
          if (current.token !== permit.record.token || !same(current.owner, permit.record.owner))
            return yield* new RayaTask.GuardError({
              message: "This routine's execution ownership changed before release.",
            })
          yield* storage.remove(key(current.runID)).pipe(Effect.orDie)
        }),
        "Routine execution release",
      )
    })

    const authorized = Effect.fn("RayaTaskExecution.authorized")(function* (run: {
      id: string
      agentID: string
      sessionID: string
    }) {
      const current = yield* load(run.id)
      if (!current) return undefined
      if (current.agentID !== run.agentID || current.sessionID !== run.sessionID) return false
      const found = durable()
      if (!found.birth || !same(current.owner, { ...found, birth: found.birth })) return false
      return active.has(current.token)
    })

    const run = <A, E, R>(permit: Permit, body: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if (!active.has(permit.record.token) || busy.has(permit.record.token))
          return yield* new RayaTask.GuardError({ message: "This routine's continuing execution is already active." })
        busy.add(permit.record.token)
        const work = Effect.withFiber((fiber) =>
          Effect.provideService(body, Current, {
            token: permit.record.token,
            agentID: permit.record.agentID,
            runID: permit.record.runID,
            sessionID: permit.record.sessionID,
            fiber,
          }),
        )
        return yield* heartbeat(permit).pipe(
          Effect.andThen(
            Effect.raceFirst(work, Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(heartbeat(permit))))),
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              busy.delete(permit.record.token)
              if (Exit.isFailure(exit)) {
                active.delete(permit.record.token)
                closing.delete(permit.record.token)
                return
              }
              if (!closing.delete(permit.record.token)) return
              yield* release(permit).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    active.delete(permit.record.token)
                  }),
                ),
              )
            }),
          ),
        )
      })

    const reentrant = (run: { id: string; agentID: string; sessionID: string }) =>
      Effect.withFiber((fiber) => {
        const current = Context.getReferenceUnsafe(fiber.context, Current)
        return Effect.succeed(
          !!current &&
            current.fiber === fiber &&
            current.agentID === run.agentID &&
            current.runID === run.id &&
            current.sessionID === run.sessionID &&
            active.has(current.token) &&
            busy.has(current.token),
        )
      })

    const enter = <A, E, R>(
      owner: { id: string; agentID: string; sessionID: SessionID },
      body: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        if (yield* reentrant(owner)) return yield* body
        const deadline = performance.now() + 5_000
        while (true) {
          if (performance.now() >= deadline) return undefined
          const result = yield* acquire(owner).pipe(Effect.exit)
          if (Exit.isFailure(result)) return undefined
          if (result.value) {
            if (performance.now() >= deadline) return undefined
            return yield* run(result.value, body)
          }
          if (yield* reentrant(owner)) return yield* body
          if (performance.now() >= deadline) return undefined
          yield* Effect.sleep("20 millis")
        }
      })

    const finish = Effect.fn("RayaTaskExecution.finish")(function* (run: {
      id: string
      agentID: string
      sessionID: string
    }) {
      const current = yield* load(run.id)
      if (!current) return
      if (current.runID !== run.id || current.agentID !== run.agentID || current.sessionID !== run.sessionID)
        return yield* new RayaTask.GuardError({
          message: "This routine's execution identity changed before completion.",
        })
      const found = durable()
      if (!found.birth || !same(current.owner, { ...found, birth: found.birth }) || !active.has(current.token)) return
      if (busy.has(current.token)) {
        closing.add(current.token)
        return
      }
      yield* release({ record: current }).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            active.delete(current.token)
            busy.delete(current.token)
            closing.delete(current.token)
          }),
        ),
      )
    })

    return { acquire, authorized, enter, finish }
  }
}
