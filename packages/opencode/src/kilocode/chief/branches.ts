import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import type { BackgroundJob } from "@/background/job"
import { mutation } from "@/kilocode/goal/mutation"

/** Durable admission and result ledger for one bounded Auto Chief fanout. */
export namespace ChiefBranches {
  export const Brief = Schema.Struct({
    objective: Schema.String,
    context: Schema.optional(Schema.String),
    constraints: Schema.Array(Schema.String),
    expectedReturn: Schema.String,
  })
  export type Brief = typeof Brief.Type

  export const Branch = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    specialist: Schema.String,
    access: Schema.Literals(["read", "edit"]),
    brief: Brief,
    state: Schema.Literals(["planned", "admitted", "completed", "failed", "cancelled", "unknown"]),
    callID: Schema.optional(Schema.String),
    sessionID: Schema.optional(SessionID),
    result: Schema.optional(Schema.String),
    review: Schema.optional(
      Schema.Struct({
        callID: Schema.String,
        messageID: Schema.String,
        partID: Schema.String,
        at: Schema.Number,
      }),
    ),
    updatedAt: Schema.Number,
  })
  export type Branch = typeof Branch.Type

  export const Record = Schema.Struct({
    version: Schema.Literal(1),
    goalID: Schema.String,
    goalCreatedAt: Schema.Number,
    requestID: Schema.String,
    createdAt: Schema.Number,
    branches: Schema.Array(Branch).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
  })
  export type Record = typeof Record.Type

  export type Input = Pick<Branch, "id" | "name" | "specialist" | "access" | "brief">
  type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
  const key = (id: SessionID) => ["raya", "chief", "branches", id]
  const goal = (id: SessionID) => ["raya", "goal", id]
  const terminal = new Set<Branch["state"]>(["completed", "failed", "cancelled", "unknown"])

  const text = (value: string) => value.trim()
  const valid = (items: readonly Input[]) => {
    if (items.length < 2 || items.length > 3) throw new Error("Auto Chief fanout requires two or three branches")
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("Auto Chief branch IDs must be unique")
    if (new Set(items.map((item) => item.name.toLowerCase())).size !== items.length)
      throw new Error("Auto Chief branch names must be unique")
    for (const item of items) {
      if (
        !text(item.id) ||
        !text(item.name) ||
        !text(item.specialist) ||
        !text(item.brief.objective) ||
        !text(item.brief.expectedReturn)
      )
        throw new Error("Every Auto Chief branch needs an identity, specialist, objective, and expected result")
    }
  }

  export function make(
    storage: Store,
    sessions?: Pick<Session.Interface, "messages">,
    background?: Pick<BackgroundJob.Interface, "list">,
  ) {
    const read = Effect.fn("ChiefBranches.read")(function* (id: SessionID) {
      const raw = yield* storage
        .read<unknown>(key(id))
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (raw === undefined) return
      return yield* Schema.decodeUnknownEffect(Record)(raw).pipe(
        Effect.mapError(() => new Error("Auto Chief branch ledger is unreadable")),
      )
    })

    const active = Effect.fn("ChiefBranches.active")(function* (id: SessionID, createdAt: number) {
      const raw = yield* storage
        .read<unknown>(goal(id))
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Auto Chief fanout requires an active goal")
      const state = raw as { createdAt?: unknown; status?: unknown }
      if (state.createdAt !== createdAt || state.status !== "active")
        throw new Error("The goal changed before Auto Chief could admit a branch")
    })

    const start = Effect.fn("ChiefBranches.start")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      requestID: string
      branches: readonly Input[]
    }) {
      valid(input.branches)
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          yield* active(input.goalID, input.goalCreatedAt)
          const old = yield* read(input.goalID)
          if (old?.goalCreatedAt === input.goalCreatedAt) {
            if (
              old.requestID === input.requestID &&
              JSON.stringify(
                old.branches.map(({ id, name, specialist, access, brief }) => ({
                  id,
                  name,
                  specialist,
                  access,
                  brief,
                })),
              ) === JSON.stringify(input.branches)
            )
              return old
            throw new Error("An Auto Chief branch plan already exists for this goal")
          }
          const now = Date.now()
          const next: Record = {
            version: 1,
            goalID: input.goalID,
            goalCreatedAt: input.goalCreatedAt,
            requestID: input.requestID,
            createdAt: now,
            branches: input.branches.map((item) => ({ ...item, state: "planned", updatedAt: now })),
          }
          yield* storage.replace(key(input.goalID), next)
          return next
        }),
      )
    })

    const admit = Effect.fn("ChiefBranches.admit")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      sessionID: SessionID
      access: Branch["access"]
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          yield* active(input.goalID, input.goalCreatedAt)
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          const item = old.branches.find((entry) => entry.id === input.branchID)
          if (!item) throw new Error("Unknown Auto Chief branch")
          if (item.access !== input.access) throw new Error("Auto Chief branch authority changed")
          if (item.state === "admitted" && item.callID === input.callID && item.sessionID === input.sessionID)
            return item
          if (item.state !== "planned") throw new Error("Auto Chief branch has already been admitted")
          if (old.branches.some((entry) => entry.callID === input.callID || entry.sessionID === input.sessionID))
            throw new Error("Auto Chief child identity is already assigned to another branch")
          const next: Branch = {
            ...item,
            state: "admitted",
            callID: input.callID,
            sessionID: input.sessionID,
            updatedAt: Date.now(),
          }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? next : entry)),
          } satisfies Record)
          return next
        }),
      )
    })

    const settle = Effect.fn("ChiefBranches.settle")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      sessionID: SessionID
      state: "completed" | "failed" | "cancelled" | "unknown"
      result: string
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          const item = old.branches.find((entry) => entry.id === input.branchID)
          if (!item || item.callID !== input.callID || item.sessionID !== input.sessionID)
            throw new Error("Auto Chief branch result does not match its admitted child")
          if (terminal.has(item.state)) {
            if (item.state === input.state && item.result === input.result) return item
            throw new Error("Auto Chief branch already has a different terminal result")
          }
          if (item.state !== "admitted") throw new Error("Auto Chief branch was not admitted")
          const next: Branch = { ...item, state: input.state, result: input.result, updatedAt: Date.now() }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? next : entry)),
          } satisfies Record)
          return next
        }),
      )
    })

    const evidence = Effect.fn("ChiefBranches.evidence")(function* (
      item: Branch,
      ref: {
        callID: string
        messageID: string
        partID: string
      },
    ) {
      if (!sessions || !item.sessionID)
        return yield* Effect.fail(new Error("Auto Chief branch evidence is unavailable"))
      const rows = yield* sessions.messages({ sessionID: item.sessionID })
      const final = rows.findLastIndex(
        (row) =>
          row.info.role === "assistant" &&
          typeof row.info.time.completed === "number" &&
          row.parts.some((part) => part.type === "text" && part.text.trim().length > 0),
      )
      if (final < 0) return false
      return rows
        .slice(0, final + 1)
        .some(
          (row) =>
            row.info.id === ref.messageID &&
            row.parts.some(
              (part) =>
                part.type === "tool" &&
                part.id === ref.partID &&
                part.callID === ref.callID &&
                part.state.status === "completed" &&
                part.tool !== "task" &&
                part.tool !== "chief_route",
            ),
        )
    })

    const review = Effect.fn("ChiefBranches.review")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      sessionID: SessionID
      evidence: { callID: string; messageID: string; partID: string }
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          const item = old.branches.find((entry) => entry.id === input.branchID)
          if (!item || item.callID !== input.callID || item.sessionID !== input.sessionID || item.state !== "completed")
            throw new Error("Only the completed, admitted branch can be reviewed")
          if (!(yield* evidence(item, input.evidence))) throw new Error("Auto Chief branch evidence was not found")
          if (item.review) {
            if (
              item.review.callID === input.evidence.callID &&
              item.review.messageID === input.evidence.messageID &&
              item.review.partID === input.evidence.partID
            )
              return item
            throw new Error("Auto Chief branch was already reviewed with different evidence")
          }
          const next: Branch = { ...item, review: { ...input.evidence, at: Date.now() }, updatedAt: Date.now() }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? next : entry)),
          } satisfies Record)
          return next
        }),
      )
    })

    /** Must be called while the goal's mutation lock is held. */
    const completion = Effect.fn("ChiefBranches.completion")(function* (id: SessionID, createdAt: number) {
      const record = yield* read(id)
      if (!record || record.goalCreatedAt !== createdAt) return
      const pending = record.branches.filter((item) => item.state !== "completed" || !item.review)
      if (pending.length)
        return yield* Effect.fail(
          new Error(
            `Auto Chief branches are unfinished or unreviewed: ${pending.map((item) => `${item.name} (${item.state})`).join(", ")}`,
          ),
        )
      if (!background) return yield* Effect.fail(new Error("Auto Chief background status is unavailable"))
      const jobs = yield* background.list()
      if (!sessions) return yield* Effect.fail(new Error("Auto Chief parent task receipts are unavailable"))
      const parent = yield* sessions.messages({ sessionID: id })
      for (const item of record.branches) {
        const receipts = parent.flatMap((row) =>
          row.info.role === "assistant"
            ? row.parts.filter(
                (part): part is MessageV2.ToolPart =>
                  part.type === "tool" &&
                  part.tool === "task" &&
                  part.callID === item.callID &&
                  part.state.status === "completed" &&
                  part.state.metadata?.parentSessionId === id &&
                  part.state.metadata?.sessionId === item.sessionID,
              )
            : [],
        )
        const receipt = receipts[0]
        if (receipts.length !== 1 || receipt?.state.status !== "completed")
          return yield* Effect.fail(new Error(`Auto Chief parent task receipt is missing or ambiguous: ${item.name}`))
        const job = jobs.find((entry) => entry.id === item.sessionID)
        if (job?.status !== undefined && job.status !== "completed")
          return yield* Effect.fail(new Error(`Auto Chief background work is unfinished or failed: ${item.name}`))
        // The completed branch ledger, parent receipt and child transcript survive a backend restart.
        // A missing in-memory job is not evidence of failure and must never trigger a replay.
        if (!item.review || !(yield* evidence(item, item.review)))
          return yield* Effect.fail(new Error(`Auto Chief branch evidence changed: ${item.name}`))
      }
    })

    return { read, start, admit, settle, review, completion }
  }
}
