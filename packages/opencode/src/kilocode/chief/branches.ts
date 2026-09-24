import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import type { BackgroundJob } from "@/background/job"
import { mutation } from "@/kilocode/goal/mutation"
import { durable, stopped } from "@/kilocode/task/owner"

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
    scope: Schema.optional(Schema.Array(Schema.String)),
    independence: Schema.optional(Schema.String),
    authority: Schema.optional(Schema.String),
    worktree: Schema.optional(
      Schema.Struct({
        name: Schema.String,
        directory: Schema.String,
        branch: Schema.String,
        baseCommit: Schema.String,
        callID: Schema.String,
        phase: Schema.Literals(["reserved", "ready", "unknown"]),
        owner: Schema.Struct({ host: Schema.String, pid: Schema.Number, birth: Schema.optional(Schema.String) }),
        integration: Schema.optional(
          Schema.Struct({
            phase: Schema.Literals(["reserved", "integrated", "unknown"]),
            digest: Schema.String,
            callID: Schema.String,
            target: Schema.String,
            owner: Schema.Struct({ host: Schema.String, pid: Schema.Number, birth: Schema.optional(Schema.String) }),
            updatedAt: Schema.Number,
          }),
        ),
        updatedAt: Schema.Number,
      }),
    ),
    state: Schema.Literals(["planned", "admitted", "completed", "failed", "cancelled", "unknown"]),
    callID: Schema.optional(Schema.String),
    sessionID: Schema.optional(SessionID),
    messageID: Schema.optional(MessageID),
    owner: Schema.optional(
      Schema.Struct({ host: Schema.String, pid: Schema.Number, birth: Schema.optional(Schema.String) }),
    ),
    result: Schema.optional(Schema.String),
    review: Schema.optional(
      Schema.Struct({
        callID: Schema.String,
        messageID: Schema.String,
        partID: Schema.String,
        digest: Schema.optional(Schema.String),
        assessment: Schema.optional(Schema.String),
        at: Schema.Number,
      }),
    ),
    updatedAt: Schema.Number,
  })
  export type Branch = typeof Branch.Type

  export const Note = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    branchID: Schema.String,
    requestID: Schema.String,
    goalCreatedAt: Schema.Number,
    taskCallID: Schema.String,
    childSessionID: SessionID,
    childMessageID: MessageID,
    senderMessageID: MessageID,
    toolCallID: Schema.String,
    text: Schema.String,
    at: Schema.Number,
    state: Schema.Literal("delivered"),
  })
  export type Note = typeof Note.Type

  /** Reports and evidence belong to the admitted input turn, never a later child conversation. */
  export function turn(rows: readonly MessageV2.WithParts[], id: MessageID | undefined) {
    if (!id) return
    const matches = rows.flatMap((row, index) => (row.info.role === "user" && row.info.id === id ? [index] : []))
    if (matches.length !== 1) return
    const start = matches[0]
    const end = rows.findIndex((row, index) => index > start && row.info.role === "user")
    const entries = rows.slice(start + 1, end < 0 ? undefined : end)
    const final = entries.findLastIndex((row) => row.info.role === "assistant")
    if (final < 0) return
    const reply = entries[final]
    if (
      reply.info.role !== "assistant" ||
      reply.info.error ||
      typeof reply.info.time.completed !== "number" ||
      !reply.parts.some((part) => part.type === "text" && part.text.trim())
    )
      return
    return { rows: entries.slice(0, final + 1), reply }
  }

  const fields = {
    goalID: Schema.String,
    goalCreatedAt: Schema.Number,
    requestID: Schema.String,
    createdAt: Schema.Number,
    branches: Schema.Array(Branch).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
    notes: Schema.optional(Schema.Array(Note)),
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

  export type Input = Pick<Branch, "id" | "name" | "specialist" | "access" | "brief"> &
    Partial<Pick<Branch, "scope" | "independence" | "authority">>
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
                old.branches.map(({ id, name, specialist, access, brief, scope, independence, authority }) => ({
                  id,
                  name,
                  specialist,
                  access,
                  brief,
                  ...(scope === undefined ? {} : { scope }),
                  ...(independence === undefined ? {} : { independence }),
                  ...(authority === undefined ? {} : { authority }),
                })),
              ) === JSON.stringify(input.branches)
            )
              return old
            if (old.branches.some((item) => item.state !== "planned" || item.worktree) || old.revision === revision)
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

    const reserveWorktree = Effect.fn("ChiefBranches.reserveWorktree")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      name: string
      directory: string
      branch: string
      baseCommit: string
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt || old.version !== 2)
            throw new Error("Auto Chief branch plan changed")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
          const item = old.branches.find((entry) => entry.id === input.branchID)
          if (!item || item.access !== "edit" || item.state !== "planned")
            throw new Error("Only a planned editing branch can reserve a worktree")
          if (
            !input.name.trim() ||
            !input.directory.trim() ||
            !input.branch.trim() ||
            !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(input.baseCommit)
          )
            throw new Error("Auto Chief worktree identity is incomplete")
          const identity = {
            name: input.name,
            directory: input.directory,
            branch: input.branch,
            baseCommit: input.baseCommit,
            callID: input.callID,
          }
          if (item.worktree) {
            if (
              item.worktree.name === identity.name &&
              item.worktree.directory === identity.directory &&
              item.worktree.branch === identity.branch &&
              item.worktree.baseCommit === identity.baseCommit &&
              item.worktree.callID === identity.callID
            )
              throw new Error("Auto Chief editing worktree is already reserved; inspect it before retrying")
            throw new Error("Auto Chief editing branch already reserved a different worktree")
          }
          if (
            old.branches.some(
              (entry) =>
                entry.worktree?.directory.toLowerCase() === input.directory.toLowerCase() ||
                entry.worktree?.branch.toLowerCase() === input.branch.toLowerCase(),
            )
          )
            throw new Error("Auto Chief worktree identity is already reserved")
          const worktree = { ...identity, phase: "reserved" as const, owner: durable(), updatedAt: Date.now() }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? { ...entry, worktree } : entry)),
          } satisfies Record)
          return worktree
        }),
      )
    })

    const readyWorktree = Effect.fn("ChiefBranches.readyWorktree")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      directory: string
      baseCommit: string
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt || old.version !== 2)
            throw new Error("Auto Chief branch plan changed")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
          const item = old.branches.find((entry) => entry.id === input.branchID)
          const worktree = item?.worktree
          if (
            !item ||
            item.state !== "planned" ||
            !worktree ||
            worktree.callID !== input.callID ||
            worktree.directory !== input.directory ||
            worktree.baseCommit !== input.baseCommit
          )
            throw new Error("Auto Chief worktree readiness does not match its reservation")
          if (worktree.phase === "ready") return worktree
          if (worktree.phase !== "reserved") throw new Error("Auto Chief worktree outcome is uncertain")
          const next = { ...worktree, phase: "ready" as const, updatedAt: Date.now() }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? { ...entry, worktree: next } : entry)),
          } satisfies Record)
          return next
        }),
      )
    })

    const uncertainWorktree = Effect.fn("ChiefBranches.uncertainWorktree")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      directory: string
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          const item = old.branches.find((entry) => entry.id === input.branchID)
          const worktree = item?.worktree
          if (!item || !worktree || worktree.callID !== input.callID || worktree.directory !== input.directory)
            throw new Error("Auto Chief worktree outcome does not match its reservation")
          if (worktree.phase === "unknown") return worktree
          if (worktree.phase !== "reserved") throw new Error("Auto Chief ready worktree cannot become uncertain")
          const next = { ...worktree, phase: "unknown" as const, updatedAt: Date.now() }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) => (entry.id === item.id ? { ...entry, worktree: next } : entry)),
          } satisfies Record)
          return next
        }),
      )
    })

    const reserveIntegration = Effect.fn("ChiefBranches.reserveIntegration")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      digest: string
      target: string
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt || old.version !== 2)
            throw new Error("Auto Chief branch plan changed")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
          const item = old.branches.find((entry) => entry.id === input.branchID)
          const worktree = item?.worktree
          if (
            !item ||
            item.access !== "edit" ||
            item.state !== "completed" ||
            !item.review ||
            worktree?.phase !== "ready"
          )
            throw new Error("Only a reviewed, completed edit branch can be integrated")
          if (item.review.digest !== input.digest) throw new Error("Auto Chief edit differs from its reviewed snapshot")
          if (!input.callID.trim() || !input.target.trim() || !/^[0-9a-f]{64}$/i.test(input.digest))
            throw new Error("Auto Chief integration identity is incomplete")
          if (worktree.integration)
            throw new Error("Auto Chief integration already has an outcome; inspect before retrying")
          if (old.branches.some((entry) => entry.worktree?.integration?.phase === "reserved"))
            throw new Error("Another Auto Chief integration is already in progress")
          const integration = {
            phase: "reserved" as const,
            digest: input.digest,
            callID: input.callID,
            target: input.target,
            owner: durable(),
            updatedAt: Date.now(),
          }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) =>
              entry.id === item.id ? { ...entry, worktree: { ...worktree, integration } } : entry,
            ),
          } satisfies Record)
          return integration
        }),
      )
    })

    const settleIntegration = Effect.fn("ChiefBranches.settleIntegration")(function* (input: {
      goalID: SessionID
      goalCreatedAt: number
      branchID: string
      callID: string
      digest: string
      phase: "integrated" | "unknown"
    }) {
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (!old || old.goalCreatedAt !== input.goalCreatedAt) throw new Error("Auto Chief branch plan changed")
          const item = old.branches.find((entry) => entry.id === input.branchID)
          const worktree = item?.worktree
          const integration = worktree?.integration
          if (
            !item ||
            !worktree ||
            !integration ||
            integration.callID !== input.callID ||
            integration.digest !== input.digest
          )
            throw new Error("Auto Chief integration receipt does not match its reservation")
          if (integration.phase === input.phase) return integration
          if (integration.phase !== "reserved") throw new Error("Auto Chief integration outcome is already settled")
          const next = { ...integration, phase: input.phase, updatedAt: Date.now() }
          yield* storage.replace(key(input.goalID), {
            ...old,
            branches: old.branches.map((entry) =>
              entry.id === item.id ? { ...entry, worktree: { ...worktree, integration: next } } : entry,
            ),
          } satisfies Record)
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
      messageID?: MessageID
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
          if (item.access === "edit" && (item.worktree?.phase !== "ready" || item.worktree.callID !== input.callID))
            throw new Error("Auto Chief editing branch has no ready worktree for this call")
          if (
            item.state === "admitted" &&
            item.callID === input.callID &&
            item.sessionID === input.sessionID &&
            item.messageID === input.messageID
          )
            return item
          if (item.state !== "planned") throw new Error("Auto Chief branch has already been admitted")
          if (old.branches.some((entry) => entry.callID === input.callID || entry.sessionID === input.sessionID))
            throw new Error("Auto Chief child identity is already assigned to another branch")
          const next: Branch = {
            ...item,
            state: "admitted",
            callID: input.callID,
            sessionID: input.sessionID,
            ...(input.messageID ? { messageID: input.messageID } : {}),
            owner: durable(),
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
          const pending = old.branches.filter(
            (item) => item.worktree?.phase === "reserved" && stopped(item.worktree.owner),
          )
          const integrations = old.branches.filter(
            (item) => item.worktree?.integration?.phase === "reserved" && stopped(item.worktree.integration.owner),
          )
          if (!stale.length && !pending.length && !integrations.length) return old
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
            branches: old.branches.map((item) => {
              const worktree = item.worktree
              const branch = pending.includes(item)
                ? {
                    ...item,
                    worktree: { ...worktree!, phase: "unknown" as const, updatedAt: now },
                    updatedAt: now,
                  }
                : item
              const adjusted =
                integrations.includes(item) && worktree?.integration
                  ? {
                      ...branch,
                      worktree: {
                        ...worktree,
                        integration: { ...worktree.integration, phase: "unknown" as const, updatedAt: now },
                      },
                    }
                  : branch
              if (!stale.includes(item)) return adjusted
              return {
                ...adjusted,
                state: proven.has(item.id) ? ("completed" as const) : ("unknown" as const),
                result: proven.has(item.id)
                  ? "Exact saved parent receipt and terminal child reply recovered after backend restart; inspect before review."
                  : "The admitting backend stopped before a terminal child result was proven. Do not replay automatically.",
                updatedAt: now,
              }
            }),
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

    const note = Effect.fn("ChiefBranches.note")(function* (
      input: {
        goalID: SessionID
        goalCreatedAt: number
        requestID: string
        branchID: string
        taskCallID: string
        childSessionID: SessionID
        childMessageID: MessageID
        senderMessageID: MessageID
        toolCallID: string
        text: string
      },
      notify?: (saved: Note, revision: string) => Effect.Effect<void>,
    ) {
      if (!input.text.trim() || input.text.length > 1_500)
        throw new Error("Chief note must contain 1 to 1,500 characters")
      return yield* mutation(
        storage,
        input.goalID,
        Effect.gen(function* () {
          const old = yield* read(input.goalID)
          if (
            !old ||
            old.version !== 2 ||
            old.goalCreatedAt !== input.goalCreatedAt ||
            old.requestID !== input.requestID
          )
            throw new Error("Chief note no longer matches the planned request")
          yield* active(input.goalID, input.goalCreatedAt, old.revision)
          const branch = old.branches.find((item) => item.id === input.branchID)
          if (
            !branch ||
            branch.state !== "admitted" ||
            branch.callID !== input.taskCallID ||
            branch.sessionID !== input.childSessionID ||
            branch.messageID !== input.childMessageID
          )
            throw new Error("Chief note sender is not the admitted running branch")
          const id = `${input.senderMessageID}:${input.toolCallID}`
          const existing = old.notes?.find((item) => item.id === id)
          if (existing) {
            if (
              existing.branchID !== input.branchID ||
              existing.childSessionID !== input.childSessionID ||
              existing.childMessageID !== input.childMessageID ||
              existing.toolCallID !== input.toolCallID ||
              existing.text !== input.text.trim()
            )
              throw new Error("Chief note call was reused with different content")
            return existing
          }
          if ((old.notes ?? []).filter((item) => item.branchID === input.branchID).length >= 8)
            throw new Error("Chief branch has reached its eight-note limit")
          const saved: Note = {
            version: 1,
            id,
            branchID: input.branchID,
            requestID: input.requestID,
            goalCreatedAt: input.goalCreatedAt,
            taskCallID: input.taskCallID,
            childSessionID: input.childSessionID,
            childMessageID: input.childMessageID,
            senderMessageID: input.senderMessageID,
            toolCallID: input.toolCallID,
            text: input.text.trim(),
            at: Date.now(),
            state: "delivered",
          }
          yield* storage.replace(key(input.goalID), { ...old, notes: [...(old.notes ?? []), saved] } satisfies Record)
          // A publish is only a hint. Confirm the durable receipt under the same mutation lock,
          // then emit once for this new note; retries that find `existing` above never emit.
          if (notify) {
            const current = yield* read(input.goalID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (current?.notes?.some((item) => item.id === saved.id && JSON.stringify(item) === JSON.stringify(saved)))
              yield* notify(saved, old.revision).pipe(Effect.catchCause(() => Effect.void))
          }
          return saved
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
      const result = turn(rows, item.messageID)
      if (!result) return false
      return result.rows.some(
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
      digest?: string
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
          if (
            item.access === "edit" &&
            (item.worktree?.phase !== "ready" || !/^[0-9a-f]{64}$/i.test(input.digest ?? ""))
          )
            throw new Error("An editing branch needs its exact ready-worktree diff fingerprint")
          if (item.access === "read" && input.digest)
            throw new Error("A read-only branch cannot claim an edit fingerprint")
          const assessment = input.assessment?.trim()
          if (input.assessment !== undefined && (!assessment || assessment.length > 2_000))
            throw new Error("Auto Chief branch assessment must be concise and nonempty")
          if (!(yield* evidence(item, input.evidence))) throw new Error("Auto Chief branch evidence was not found")
          if (item.review) {
            if (
              item.review.callID === input.evidence.callID &&
              item.review.messageID === input.evidence.messageID &&
              item.review.partID === input.evidence.partID &&
              item.review.digest === input.digest &&
              item.review.assessment === assessment
            )
              return item
            throw new Error("Auto Chief branch was already reviewed with different evidence")
          }
          const next: Branch = {
            ...item,
            review: {
              ...input.evidence,
              ...(input.digest ? { digest: input.digest } : {}),
              ...(assessment ? { assessment } : {}),
              at: Date.now(),
            },
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
      const edits = record.branches.filter(
        (item) => item.access === "edit" && item.worktree?.integration?.phase !== "integrated",
      )
      if (edits.length)
        return yield* Effect.fail(
          new Error(
            `Auto Chief edits are still isolated in worktrees and need reviewed integration: ${edits.map((item) => item.name).join(", ")}`,
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

    return {
      read,
      start,
      reserveWorktree,
      readyWorktree,
      uncertainWorktree,
      reserveIntegration,
      settleIntegration,
      admit,
      reconcile,
      settle,
      note,
      review,
      synthesize,
      completion,
    }
  }
}
