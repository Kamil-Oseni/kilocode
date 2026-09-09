import { Cause, Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Log from "@opencode-ai/core/util/log"
import type { BackgroundJob } from "@/background/job"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { outstanding } from "./stop-jobs"
import type { Operation } from "./stop-operation"

const log = Log.create({ service: "raya-goal-jobs" })

const resolve = (
  sessionID: SessionID,
  messages: readonly MessageID[],
  jobs: BackgroundJob.Info[],
  sessions: Pick<Session.Interface, "messages">,
) =>
  Effect.gen(function* () {
    const cache = new Map<string, SessionV1.WithParts[]>()
    const read = (id: string) =>
      Effect.gen(function* () {
        const saved = cache.get(id)
        if (saved) return saved
        const rows = yield* sessions.messages({ sessionID: SessionID.make(id) })
        cache.set(id, rows)
        return rows
      })
    const root = yield* read(sessionID)
    const requested = new Set(messages)
    const available = root
      .filter((row) => row.info.sessionID === sessionID && row.info.role === "user" && requested.has(row.info.id))
      .map((row) => row.info.id)
    const inputs = new Map<string, Set<string>>([[sessionID, new Set(available)]])
    const owned = new Map<string, BackgroundJob.Info>()
    for (;;) {
      let changed = false
      for (const job of jobs) {
        if (owned.has(job.id) || job.type !== "task" || !job.revision || !job.origins?.length) continue
        const verified = yield* Effect.forEach(job.origins, (origin) =>
          Effect.gen(function* () {
            if (!origin || !inputs.has(origin.sessionID) || origin.childSessionID !== job.id || !origin.childMessageID)
              return false
            const rows = yield* read(origin.sessionID)
            const matches = rows.filter(
              (row) => row.info.id === origin.messageID && row.info.sessionID === origin.sessionID,
            )
            if (matches.length !== 1) return false
            const source = matches[0]
            if (source.info.role !== "assistant" || !inputs.get(origin.sessionID)?.has(source.info.parentID))
              return false
            const calls = source.parts.filter((part) => part.type === "tool" && part.callID === origin.callID)
            if (calls.length !== 1) return false
            const call = calls[0]
            return (
              call.type === "tool" &&
              call.tool === "task" &&
              call.sessionID === origin.sessionID &&
              call.messageID === origin.messageID &&
              call.state.status !== "pending" &&
              call.state.metadata?.sessionId === job.id
            )
          }),
        )
        // Whole-scope cancellation still requires every admission to be owned.
        if (verified.every(Boolean)) owned.set(job.id, job)
        const disputed = new Set(
          job.origins.flatMap((origin, index) =>
            !verified[index] && origin?.childMessageID ? [origin.childMessageID] : [],
          ),
        )
        for (const [index, origin] of job.origins.entries()) {
          if (!verified[index] || !origin?.childMessageID || disputed.has(origin.childMessageID)) continue
          // A verified input can own descendants even when another input shares this job.
          const allowed = inputs.get(job.id) ?? new Set<string>()
          if (!allowed.has(origin.childMessageID)) changed = true
          allowed.add(origin.childMessageID)
          inputs.set(job.id, allowed)
        }
      }
      if (!changed)
        return {
          owned: [...owned.values()],
          partial: jobs.flatMap((job) =>
            !owned.has(job.id) && job.type === "task" && job.revision && inputs.has(job.id)
              ? [{ job, messages: [...inputs.get(job.id)!] }]
              : [],
          ),
        }
    }
  })

/** Resolve persisted invocation edges, then cancel only the observed revisions. */
export const settle = (
  sessionID: SessionID,
  messages: readonly MessageID[],
  sessions: Pick<Session.Interface, "messages">,
  background: Pick<BackgroundJob.Interface, "list" | "cancel"> & Partial<Pick<BackgroundJob.Interface, "cancelInput">>,
  record?: (operation: Operation) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const attempted = new Set<string>()
    const cancel = (job: BackgroundJob.Info, messageID?: MessageID) =>
      Effect.gen(function* () {
        const operation = {
          id: crypto.randomUUID(),
          jobID: job.id,
          revision: job.revision!,
          ...(messageID ? { messageID } : {}),
          at: Date.now(),
          phase: "requested" as const,
        }
        // Persist intent before selecting work; a failed write must prevent cancellation.
        if (record) yield* record(operation)
        const result = messageID
          ? (yield* background.cancelInput!(job.id, job.revision!, messageID))
            ? "accepted"
            : "not-selected"
          : ((yield* background.cancel(job.id, job.revision!))?.status ?? "not-selected")
        if (record) yield* record({ ...operation, phase: "observed", observedAt: Date.now(), result })
      })
    for (;;) {
      const rows = yield* background.list()
      const resolved = yield* resolve(sessionID, messages, rows, sessions)
      const pending = resolved.owned.filter((job) => job.status === "running" && !attempted.has(job.revision!))
      const partial = background.cancelInput
        ? resolved.partial.flatMap(({ job, messages }) =>
            job.status === "running"
              ? messages.flatMap((message) => {
                  const key = JSON.stringify([job.revision, message])
                  return attempted.has(key) ? [] : [{ job, message, key }]
                })
              : [],
          )
        : []
      if (!pending.length && !partial.length) break
      for (const job of pending) {
        attempted.add(job.revision!)
        yield* cancel(job)
      }
      for (const item of partial) {
        attempted.add(item.key)
        yield* cancel(item.job, MessageID.make(item.message))
      }
      // Parent cleanup has settled; include descendants admitted before it finished.
    }
    return yield* outstanding(sessionID, background)
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      log.warn("Delegated goal cancellation could not be confirmed.", { sessionID, cause: String(cause) })
      return outstanding(sessionID, background).pipe(
        Effect.map((result) => ({ ...result, status: "unavailable" as const })),
      )
    }),
  )
