import { and, eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineOccurrenceTable as Occurrence,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import type { RayaTaskInbox } from "./inbox"
import { mutate } from "./mutation"

type Tasks = Pick<ReturnType<typeof RayaTask.make>, "get" | "runsFor">
type Inbox = ReturnType<typeof RayaTaskInbox.make>
type Input = {
  agent: RayaTask.Agent
  occurrenceID: string
  reason: "busy" | "deferred"
  now?: number
  threshold?: number
  quiet?: boolean
}
type Dependencies = {
  storage: Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
  database: Database.Interface
  tasks: Tasks
  inbox: Pick<Inbox, "publish">
  check(): Effect.Effect<void, RayaTask.GuardError>
  publish?(input: {
    agent: RayaTask.Agent
    id: string
    at: number
    summary: string
    notice: { at: number; reason: Input["reason"] }
  }): Effect.Effect<unknown, unknown>
}

function definition(agent: RayaTask.Agent) {
  const { execution: _execution, nextRun: _next, note: _note, updatedAt: _updated, ...selected } = agent
  return JSON.parse(JSON.stringify(selected)) as unknown
}

/** A unique inbox source is the durable once-per-occurrence receipt; no model turn is created. */
export namespace RayaTaskWait {
  export function make(input: Dependencies) {
    const notice = Effect.fn("RayaTaskWait.notice")(function* (request: Input) {
      const now = request.now ?? Date.now()
      const delay = request.threshold ?? 30 * 60_000
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(delay) || delay < 0 || delay > 7 * 86400_000)
        return yield* new RayaTask.GuardError({ message: "A valid waiting-notice time and threshold are required." })
      if (request.reason !== "busy" && request.reason !== "deferred") return undefined
      const result = yield* mutate(
        input.storage,
        Effect.gen(function* () {
          yield* input.check()
          const current = yield* input.tasks
            .get(request.agent.id)
            .pipe(Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(undefined)))
          if (!current?.enabled || !isDeepStrictEqual(definition(current), definition(request.agent))) return undefined
          const runs = yield* input.tasks.runsFor(current.id)
          if (runs.some((run) => run.status === "blocked" && run.blockedReason === "waiting on you")) return undefined
          return yield* input.database.db.transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* input.check()
                const queued = yield* tx
                  .select()
                  .from(Occurrence)
                  .where(
                    and(
                      eq(Occurrence.id, request.occurrenceID),
                      eq(Occurrence.agent_id, current.id),
                      eq(Occurrence.schedule_version, current.scheduleVersion ?? 1),
                      eq(Occurrence.state, "queued"),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (!queued || queued.scheduled_at > now || now - queued.observed_at <= delay) return undefined
                const source = "wait:" + createHash("sha256").update(queued.id).digest("hex")
                const prior = yield* tx
                  .select()
                  .from(Message)
                  .where(and(eq(Message.agent_id, current.id), eq(Message.source, source)))
                  .get()
                  .pipe(Effect.orDie)
                if (prior && (prior.kind !== "system" || prior.occurrence_id !== source))
                  return yield* new RayaTask.GuardError({
                    message: "The waiting notice has a different durable identity.",
                  })
                const body =
                  prior?.body ??
                  (request.reason === "busy"
                    ? "This scheduled occurrence has been queued for a while because another run of this routine is still active."
                    : "This scheduled occurrence has been queued for a while because its start is deferred.")
                yield* input.check()
                const record = yield* input.inbox.publish({
                  agentID: current.id,
                  source,
                  kind: "system",
                  body,
                  // Inbox identities are bounded tokens; the source hash binds the canonical SQL occurrence.
                  occurrenceID: source,
                })
                yield* input.check()
                return { agent: current, record, created: !prior, quiet: request.quiet === true }
              }),
            { behavior: "immediate" },
          )
        }),
      )
      if (!result) return undefined
      yield* input.check()
      if (input.publish)
        yield* input.publish({
          agent: result.agent,
          id: request.occurrenceID,
          at: result.record.time,
          summary: result.record.body,
          notice: { at: result.record.time, reason: request.reason },
        })
      return result
    })
    return { notice }
  }
}
