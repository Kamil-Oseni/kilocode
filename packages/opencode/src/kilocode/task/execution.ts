import { createHash } from "node:crypto"
import { Context, Effect, Exit, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { GlobalBus } from "@/bus/global"
import { ExecutionIdle } from "./execution-event"
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
  // Records written before the state marker remain uncertain and are never removed by terminal recovery.
  state: Schema.optional(Schema.Literals(["active", "idle", "recovering"])),
})
const Review = Schema.Struct({
  version: Schema.Literal(1),
  actor: Schema.Literal("user"),
  at: Schema.Int,
  record: Record,
})
type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
type Permit = { record: typeof Record.Type }
type Capability = { token: string; agentID: string; runID: string; sessionID: string; fiber: unknown }
const Current = Context.Reference<Capability | undefined>("@raya/RoutineExecution", { defaultValue: () => undefined })
const active = new Set<string>()
const busy = new Set<string>()
const closing = new Set<string>()
const recovering = new Set<string>()
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
            if (prior.state === "recovering")
              return yield* new RayaTask.GuardError({
                message: "This routine's execution outcome is uncertain and needs recovery review.",
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
            state: "active",
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
            current.runID !== permit.record.runID ||
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

    const mark = Effect.fn("RayaTaskExecution.mark")(function* (permit: Permit, state: "active" | "idle") {
      yield* mutate(
        storage,
        Effect.gen(function* () {
          const current = yield* load(permit.record.runID)
          if (
            !current ||
            current.token !== permit.record.token ||
            !same(current.owner, permit.record.owner) ||
            current.runID !== permit.record.runID ||
            current.agentID !== permit.record.agentID ||
            current.sessionID !== permit.record.sessionID
          )
            return yield* new RayaTask.GuardError({
              message: "This routine lost its exact execution ownership.",
            })
          yield* storage.replace(key(current.runID), { ...current, state, updatedAt: Date.now() }).pipe(Effect.orDie)
        }),
        "Routine execution state",
      )
    })

    const release = Effect.fn("RayaTaskExecution.release")(function* (permit: Permit) {
      yield* mutate(
        storage,
        Effect.gen(function* () {
          const current = yield* load(permit.record.runID)
          if (!current) return
          if (
            current.token !== permit.record.token ||
            !same(current.owner, permit.record.owner) ||
            current.runID !== permit.record.runID ||
            current.agentID !== permit.record.agentID ||
            current.sessionID !== permit.record.sessionID
          )
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
        return yield* mark(permit, "active").pipe(
          Effect.andThen(heartbeat(permit)),
          Effect.andThen(
            Effect.raceFirst(work, Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(heartbeat(permit))))),
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (Exit.isFailure(exit)) {
                active.delete(permit.record.token)
                closing.delete(permit.record.token)
                return
              }
              yield* mark(permit, "idle")
              if (!closing.delete(permit.record.token)) return
              yield* release(permit).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    active.delete(permit.record.token)
                  }),
                ),
              )
            }).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  active.delete(permit.record.token)
                  closing.delete(permit.record.token)
                }),
              ),
              Effect.onExit((settled) =>
                Effect.gen(function* () {
                  busy.delete(permit.record.token)
                  if (!Exit.isSuccess(exit) || !Exit.isSuccess(settled) || !active.has(permit.record.token)) return
                  yield* Effect.try({
                    try: () =>
                      GlobalBus.emit("event", {
                        payload: {
                          type: ExecutionIdle.type,
                          properties: {
                            version: 1,
                            runID: permit.record.runID,
                            agentID: permit.record.agentID,
                            sessionID: SessionID.make(permit.record.sessionID),
                            execution: hash(permit.record.token),
                          },
                        },
                      }),
                    catch: () => new Error("Routine idle notification listener failed"),
                  }).pipe(
                    Effect.catch(() =>
                      Effect.logWarning(
                        "Routine idle notification could not be delivered; queued intake remains saved for recovery.",
                      ),
                    ),
                  )
                }),
              ),
            ),
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

    const retained = Effect.fn("RayaTaskExecution.retained")(function* (run: {
      id: string
      agentID: string
      sessionID: string
    }) {
      const current = yield* load(run.id)
      if (!current) return false
      if (current.runID === run.id && current.agentID === run.agentID && current.sessionID === run.sessionID)
        return true
      return yield* new RayaTask.GuardError({
        message: "This routine's retained execution identity needs recovery review.",
      })
    })

    const receipt = Effect.fn("RayaTaskExecution.receipt")(function* (run: {
      id: string
      agentID: string
      sessionID: string
    }) {
      const current = yield* load(run.id)
      if (!current) return undefined
      if (current.runID === run.id && current.agentID === run.agentID && current.sessionID === run.sessionID)
        return current
      return yield* new RayaTask.GuardError({ message: "This routine's execution identity needs recovery review." })
    })

    const idle = Effect.fn("RayaTaskExecution.idle")(function* (
      run: { id: string; agentID: string; sessionID: string },
      digest: string,
    ) {
      return yield* mutate(
        storage,
        Effect.gen(function* () {
          const current = yield* receipt(run)
          const found = durable()
          return (
            !!current &&
            hash(current.token) === digest &&
            current.state === "idle" &&
            !!found.birth &&
            same(current.owner, { ...found, birth: found.birth }) &&
            active.has(current.token) &&
            !busy.has(current.token)
          )
        }),
        "Routine idle notification",
      )
    })

    const reviewed = Effect.fn("RayaTaskExecution.reviewed")(function* (
      run: { id: string; agentID: string; sessionID: string },
      digest: string,
    ) {
      if (!/^[a-f0-9]{64}$/.test(digest))
        return yield* new RayaTask.GuardError({ message: "This routine's recovery review identity is invalid." })
      const value = yield* read(storage, ["raya", "agent-execution-reviews", hash(run.id), digest]).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      )
      if (value === undefined) return undefined
      const saved = yield* Schema.decodeUnknownEffect(Review)(value).pipe(Effect.orDie)
      if (
        saved.record.runID !== run.id ||
        saved.record.agentID !== run.agentID ||
        saved.record.sessionID !== run.sessionID ||
        hash(saved.record.token) !== digest
      )
        return yield* new RayaTask.GuardError({ message: "This routine's saved recovery review changed." })
      return saved.record
    })

    // Called only after an explicit user review. Retain the old effect receipt before freeing new intake.
    const review = Effect.fn("RayaTaskExecution.review")(function* (
      run: { id: string; agentID: string; sessionID: string },
      token: string,
    ) {
      yield* mutate(
        storage,
        Effect.gen(function* () {
          const path = ["raya", "agent-execution-reviews", hash(run.id), hash(token)]
          const saved = yield* read(storage, path).pipe(
            Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
            Effect.flatMap((value) =>
              value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(Review)(value),
            ),
            Effect.orDie,
          )
          if (
            saved &&
            (saved.record.token !== token ||
              saved.record.runID !== run.id ||
              saved.record.agentID !== run.agentID ||
              saved.record.sessionID !== run.sessionID)
          )
            return yield* new RayaTask.GuardError({ message: "This routine's saved recovery review changed." })
          const current = yield* receipt(run)
          if (!current) {
            if (saved) return
            return yield* new RayaTask.GuardError({ message: "This routine has no exact execution receipt to review." })
          }
          if (current.token !== token || current.state === "recovering" || recovering.has(token) || busy.has(token))
            return yield* new RayaTask.GuardError({
              message: "This routine is still working or its execution changed. Review it again after it stops.",
            })
          const found = durable()
          if (!(found.birth && same(current.owner, { ...found, birth: found.birth })) && !stopped(current.owner))
            return yield* new RayaTask.GuardError({
              message: "This routine may still be working in another backend. Wait for it to stop before reviewing.",
            })
          if (saved && !same(saved.record.owner, current.owner))
            return yield* new RayaTask.GuardError({ message: "This routine's execution owner changed after review." })
          if (
            !saved &&
            !(yield* storage
              .create(path, { version: 1, actor: "user", at: Date.now(), record: current })
              .pipe(Effect.orDie))
          )
            return yield* new RayaTask.GuardError({
              message: "This routine's recovery review changed before it was saved.",
            })
          yield* storage.remove(key(run.id)).pipe(Effect.orDie)
          active.delete(token)
          closing.delete(token)
        }),
        "Routine execution review",
      )
    })

    const terminal = Effect.fn("RayaTaskExecution.terminal")(function* (run: {
      id: string
      agentID: string
      sessionID: string
    }) {
      const found = durable()
      if (!found.birth)
        return yield* new RayaTask.GuardError({
          message: "This backend cannot prove its process identity for terminal routine recovery.",
        })
      const identity = { ...found, birth: found.birth }
      const result = yield* mutate(
        storage,
        Effect.gen(function* () {
          const prior = yield* load(run.id)
          if (prior && (prior.runID !== run.id || prior.agentID !== run.agentID || prior.sessionID !== run.sessionID))
            return yield* new RayaTask.GuardError({
              message: "This routine's execution identity changed before terminal recovery.",
            })
          if (prior) {
            if (prior.state === undefined || prior.state === "active") return undefined
            if (prior.state === "idle" && !stopped(prior.owner)) return undefined
            if (prior.state === "recovering" && same(prior.owner, identity)) {
              if (recovering.has(prior.token)) return undefined
              recovering.add(prior.token)
              return { record: prior } satisfies Permit
            }
            if (prior.state === "recovering" && !stopped(prior.owner)) return undefined
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
            state: "recovering",
          }
          if (prior) yield* storage.replace(key(run.id), record).pipe(Effect.orDie)
          else if (!(yield* storage.create(key(run.id), record).pipe(Effect.orDie)))
            return yield* Effect.die(new Error("Routine terminal ownership changed during admission."))
          recovering.add(record.token)
          return { record, prior: prior?.token }
        }),
        "Routine terminal execution",
      )
      if (!result) return undefined
      if ("prior" in result && result.prior) {
        active.delete(result.prior)
        busy.delete(result.prior)
        closing.delete(result.prior)
      }
      return { record: result.record } satisfies Permit
    })

    const complete = Effect.fn("RayaTaskExecution.complete")(function* (permit: Permit) {
      yield* mutate(
        storage,
        Effect.gen(function* () {
          const current = yield* load(permit.record.runID)
          if (
            !current ||
            current.state !== "recovering" ||
            current.token !== permit.record.token ||
            !same(current.owner, permit.record.owner) ||
            current.runID !== permit.record.runID ||
            current.agentID !== permit.record.agentID ||
            current.sessionID !== permit.record.sessionID
          )
            return yield* new RayaTask.GuardError({
              message: "This routine's terminal recovery ownership changed before completion.",
            })
          yield* storage.remove(key(current.runID)).pipe(Effect.orDie)
        }),
        "Routine terminal completion",
      )
    })

    const recover = <A, E, R>(permit: Permit, body: Effect.Effect<A, E, R>) =>
      body.pipe(
        Effect.tap(() => complete(permit)),
        Effect.ensuring(Effect.sync(() => recovering.delete(permit.record.token))),
      )
    const defer = (permit: Permit) => Effect.sync(() => recovering.delete(permit.record.token))

    return { acquire, authorized, retained, receipt, idle, reviewed, review, enter, finish, terminal, recover, defer }
  }
}
