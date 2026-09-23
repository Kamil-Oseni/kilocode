import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import type { BackgroundJob } from "@/background/job"
import { mutation } from "@/kilocode/goal/mutation"
import { owner, stopped } from "@/kilocode/task/owner"

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
    owner: Schema.optional(Schema.Struct({ host: Schema.String, pid: Schema.Number })),
    result: Schema.optional(Schema.String),
    review: Schema.optional(
      Schema.Struct({
        callID: Schema.String,
        messageID: Schema.String,
        partID: Schema.String,
        assessment: Schema.optional(Schema.String),
        at: Schema.Number,
      }),
    ),
    updatedAt: Schema.Number,
  })
  export type Branch = typeof Branch.Type

  const fields = {
    goalID: Schema.String,
    goalCreatedAt: Schema.Number,
    requestID: Schema.String,
    createdAt: Schema.Number,
    branches: Schema.Array(Branch).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
    synthesis: Schema.optional(
      Schema.Struct({
        summary: Schema.String,
        findings: Schema.Array(Schema.Struct({ branchID: Schema.String, conclusion: Schema.String })),
        at: Schema.Number,
      }),
    ),
  }
  export const Record = Schema.Union([
    Schema.Struct({ version: Schema.Literal(1), revision: Schema.optional(Schema.String), ...fields }),
    Schema.Struct({ version: Schema.Literal(2), revision: Schema.String, ...fields }),
  ])
  export type Record = typeof Record.Type

  export function matches(
    record: Record,
    goal:
      | {
          createdAt?: number
          status?: string
          revisions?: readonly { id?: string }[]
        }
      | undefined,
  ) {
    return (
      record.version === 2 &&
      goal?.status === "active" &&
      goal.createdAt === record.goalCreatedAt &&
      (goal.revisions?.at(-1)?.id ?? "") === record.revision
    )
  }

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
    sessions?: Pick<Session.Interface, "messages"> & Partial<Pick<Session.Interface, "get">>,
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

    const active = Effect.fn("ChiefBranches.active")(function* (id: SessionID, createdAt: number, revision?: string) {
      const raw = yield* storage
        .read<unknown>(goal(id))
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Auto Chief fanout requires an active goal")
      const state = raw as { createdAt?: unknown; status?: unknown; revisions?: { id?: unknown }[] }
      if (state.createdAt !== createdAt || state.status !== "active")
        throw new Error("The goal changed before Auto Chief could admit a branch")
      const current = state.revisions?.at(-1)?.id ?? ""
      if (typeof current !== "string" || (revision !== undefined && current !== revision))
        throw new Error("The goal was revised after Auto Chief planned its branches")
      return current
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
          const revision = yield* active(input.goalID, input.goalCreatedAt)
          const old = yield* read(input.goalID)
          if (old?.goalCreatedAt === input.goalCreatedAt) {
            if (
              old.version === 2 &&
              old.revision === revision &&
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
            if (old.branches.some((item) => item.state !== "planned") || old.revision === revision)
              throw new Error("An Auto Chief branch plan already exists for this goal")
          }
          const now = Date.now()
          const next: Record = {
            version: 2,
            revision,
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
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          if (old.version !== 2) throw new Error("Legacy Auto Chief branch plan cannot admit new work")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
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
            owner: owner(),
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

    /** A proven dead owner can leave effects unknown, but can never authorize replay. */
    const reconcile = Effect.fn("ChiefBranches.reconcile")(function* (
      id: SessionID,
      createdAt: number,
      revision?: string,
    ) {
      return yield* mutation(
        storage,
        id,
        Effect.gen(function* () {
          const old = yield* read(id)
          if (!old || old.goalCreatedAt !== createdAt) throw new Error("Auto Chief branch plan changed")
          if (revision !== undefined) yield* active(id, createdAt, revision)
          const stale = old.branches.filter((item) => item.state === "admitted" && stopped(item.owner))
          if (!stale.length) return old
          const proven = new Set<string>()
          if (sessions?.get) {
            const parent = yield* sessions.messages({ sessionID: id })
            for (const item of stale) {
              if (!item.callID || !item.sessionID) continue
              const receipts = parent.flatMap((row) =>
                row.info.role === "assistant"
                  ? row.parts.filter(
                      (part): part is MessageV2.ToolPart =>
                        part.type === "tool" && part.tool === "task" && part.callID === item.callID,
                    )
                  : [],
              )
              const receipt = receipts[0]
              if (
                receipts.length !== 1 ||
                receipt.state.status !== "completed" ||
                receipt.state.metadata?.parentSessionId !== id ||
                receipt.state.metadata?.sessionId !== item.sessionID ||
                typeof receipt.state.metadata?.childMessageID !== "string"
              )
                continue
              const message = receipt.state.metadata?.childMessageID
              const child = yield* sessions.get(item.sessionID)
              if (child?.parentID !== id) continue
              const rows = yield* sessions.messages({ sessionID: item.sessionID })
              const input = rows.findIndex((row) => row.info.role === "user" && row.info.id === message)
              if (input < 0) continue
              const next = rows.findIndex((row, index) => index > input && row.info.role === "user")
              const turn = rows.slice(input + 1, next < 0 ? undefined : next)
              const final = turn.findLast((row) => row.info.role === "assistant")
              if (
                final?.info.role === "assistant" &&
                !final.info.error &&
                typeof final.info.time.completed === "number" &&
                final.parts.some((part) => part.type === "text" && part.text.trim().length > 0)
              )
                proven.add(item.id)
            }
          }
          const now = Date.now()
          const next: Record = {
            ...old,
            branches: old.branches.map((item) =>
              stale.includes(item)
                ? {
                    ...item,
                    state: proven.has(item.id) ? "completed" : "unknown",
                    result: proven.has(item.id)
                      ? "Exact saved parent receipt and terminal child reply recovered after backend restart; inspect before review."
                      : "The admitting backend stopped before a terminal child result was proven. Do not replay automatically.",
                    updatedAt: now,
                  }
                : item,
            ),
          }
          yield* storage.replace(key(id), next)
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
      assessment?: string
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          if (old.version !== 2) throw new Error("Legacy Auto Chief branch plan cannot be reviewed")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
          const item = old.branches.find((entry) => entry.id === input.branchID)
          if (!item || item.callID !== input.callID || item.sessionID !== input.sessionID || item.state !== "completed")
            throw new Error("Only the completed, admitted branch can be reviewed")
          const assessment = input.assessment?.trim()
          if (input.assessment !== undefined && (!assessment || assessment.length > 2_000))
            throw new Error("Auto Chief branch assessment must be concise and nonempty")
          if (!(yield* evidence(item, input.evidence))) throw new Error("Auto Chief branch evidence was not found")
          if (item.review) {
            if (
              item.review.callID === input.evidence.callID &&
              item.review.messageID === input.evidence.messageID &&
              item.review.partID === input.evidence.partID &&
              item.review.assessment === assessment
            )
              return item
            throw new Error("Auto Chief branch was already reviewed with different evidence")
          }
          const next: Branch = {
            ...item,
            review: { ...input.evidence, ...(assessment ? { assessment } : {}), at: Date.now() },
          }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? next : entry)),
          } satisfies Record)
          return next
        }),
      )
    })

    const synthesize = Effect.fn("ChiefBranches.synthesize")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      summary: string
      findings: readonly { branchID: string; conclusion: string }[]
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          if (old.version !== 2) throw new Error("Legacy Auto Chief branch plan cannot be synthesized")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
          const summary = input.summary.trim()
          if (!summary || summary.length > 4_000) throw new Error("Auto Chief synthesis needs a bounded summary")
          if (
            input.findings.length !== old.branches.length ||
            new Set(input.findings.map((item) => item.branchID)).size !== old.branches.length ||
            input.findings.some((item) => !old.branches.some((branch) => branch.id === item.branchID))
          )
            throw new Error("Auto Chief synthesis must cover every planned branch exactly once")
          if (old.branches.some((item) => item.state !== "completed" || !item.review))
            throw new Error("Auto Chief cannot synthesize unfinished or unreviewed branches")
          const findings = old.branches.map((item) => {
            const conclusion = input.findings.find((entry) => entry.branchID === item.id)?.conclusion.trim() ?? ""
            if (!conclusion || conclusion.length > 2_000)
              throw new Error(`Auto Chief synthesis needs a bounded conclusion for ${item.name}`)
            return { branchID: item.id, conclusion }
          })
          if (old.synthesis) {
            if (
              old.synthesis.summary === summary &&
              JSON.stringify(old.synthesis.findings) === JSON.stringify(findings)
            )
              return old.synthesis
            throw new Error("Auto Chief synthesis was already saved with different conclusions")
          }
          const synthesis = { summary, findings, at: Date.now() }
          yield* storage.replace(key(input.goalID), { ...old, synthesis } satisfies Record)
          return synthesis
        }),
      )
    })

    /** Must be called while the goal's mutation lock is held. */
    const completion = Effect.fn("ChiefBranches.completion")(function* (id: SessionID, createdAt: number) {
      const record = yield* read(id)
      if (!record || record.goalCreatedAt !== createdAt) return
      if (record.version !== 2) return yield* Effect.fail(new Error("Legacy Auto Chief branch plan is incomplete"))
      yield* active(id, createdAt, record.revision)
      const pending = record.branches.filter((item) => item.state !== "completed" || !item.review)
      if (pending.length)
        return yield* Effect.fail(
          new Error(
            `Auto Chief branches are unfinished or unreviewed: ${pending.map((item) => `${item.name} (${item.state})`).join(", ")}`,
          ),
        )
      if (
        !record.synthesis ||
        record.synthesis.findings.length !== record.branches.length ||
        record.branches.some(
          (item) => record.synthesis?.findings.filter((entry) => entry.branchID === item.id).length !== 1,
        )
      )
        return yield* Effect.fail(new Error("Auto Chief has not synthesized every reviewed branch"))
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

    return { read, start, admit, reconcile, settle, review, synthesize, completion }
  }
}
