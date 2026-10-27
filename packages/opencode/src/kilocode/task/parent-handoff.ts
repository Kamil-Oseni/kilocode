import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "."
import * as Lineage from "./effect-lineage"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Record = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["ready", "entered"]),
  run: Hash,
  session: Hash,
  goal: Schema.Struct({ createdAt: Schema.Finite, revision: Name, intent: Schema.optional(Name) }),
  execution: Schema.Struct({ token: Name, digest: Hash }),
})
export type Handoff = typeof Record.Type
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")
const pin = (run: RayaTask.Run) =>
  digest({
    id: run.id,
    agentID: run.agentID,
    sessionID: run.sessionID,
    at: run.at,
    goalCreatedAt: run.goalCreatedAt,
    trigger: run.trigger,
    scheduleVersion: run.scheduleVersion,
  })
const key = (run: RayaTask.Run) => [
  "raya",
  "parent-handoffs",
  digest([run.agentID, run.id, run.sessionID, run.goalCreatedAt]),
]
const refuse = () =>
  new RayaTask.GuardError({ kind: "unavailable", message: "The original parent continuation needs recovery review." })
const same = (record: Handoff, run: RayaTask.Run, goal: RayaGoal.State, identity: unknown) =>
  run.status === "running" &&
  record.run === pin(run) &&
  record.session === digest(identity) &&
  run.goalCreatedAt === goal.createdAt &&
  record.goal.createdAt === goal.createdAt &&
  record.goal.revision === goal.revision &&
  record.goal.intent === goal.intent &&
  goal.status === "active"

export function make(storage: Pick<Storage.Interface, "readBounded" | "replace">) {
  const read = (run: RayaTask.Run) =>
    storage.readBounded<unknown>(key(run), 4096).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Record)),
      Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      Effect.mapError(refuse),
    )
  const prepare = (
    run: RayaTask.Run,
    goal: RayaGoal.State,
    identity: unknown,
    receipt: { token: string; state?: string } | undefined,
  ) =>
    Effect.gen(function* () {
      if (
        run.status !== "running" ||
        run.goalCreatedAt !== goal.createdAt ||
        !goal.revision ||
        goal.status !== "active" ||
        receipt?.state !== "idle"
      )
        return yield* refuse()
      const record = yield* Schema.decodeUnknownEffect(Record)({
        version: 1,
        phase: "ready",
        run: pin(run),
        session: digest(identity),
        goal: { createdAt: goal.createdAt, revision: goal.revision, intent: goal.intent },
        execution: { token: receipt.token, digest: digest(receipt) },
      }).pipe(Effect.mapError(refuse))
      yield* storage.replace(key(run), record).pipe(Effect.mapError(refuse))
      return goal.revision
    })
  const ready = (
    run: RayaTask.Run,
    goal: RayaGoal.State,
    identity: unknown,
    receipt: { token: string; state?: string } | undefined,
  ) =>
    Effect.gen(function* () {
      const record = yield* read(run)
      if (!record || record.phase === "entered") return
      if (
        !same(record, run, goal, identity) ||
        receipt?.state !== "idle" ||
        record.execution.token !== receipt.token ||
        record.execution.digest !== digest(receipt)
      )
        return yield* refuse()
      return record
    })
  const enter = (run: RayaTask.Run, record: Handoff, goal: RayaGoal.State, identity: unknown) =>
    Effect.gen(function* () {
      if (
        !(yield* Lineage.matches(run)) ||
        (yield* Lineage.origin())?.predecessor !== record.execution.digest ||
        !same(record, run, goal, identity)
      )
        return yield* refuse()
      const current = yield* read(run)
      if (current?.phase === "entered") return false
      if (!isDeepStrictEqual(current, record)) return yield* refuse()
      yield* storage.replace(key(run), { ...record, phase: "entered" }).pipe(Effect.mapError(refuse))
      return true
    })
  return { prepare, ready, enter, read }
}
