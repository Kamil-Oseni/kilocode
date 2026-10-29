import { Effect, Option, Schema } from "effect"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import type { BackgroundJob } from "@/background/job"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { mutation } from "@/kilocode/goal/mutation"
import { gate } from "@/kilocode/session/input-gate"
import { RayaChief } from "."
import { ChiefRefinement } from "./refinement"
import { ResultContract } from "./result-contract"
import { Refusal } from "@/kilocode/session/tool-refusal"
import { example } from "@/kilocode/task-resume"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { compacted } from "@/kilocode/goal/compaction-lineage"
import * as ReadProof from "./request-read"

export namespace ChiefVerification {
  export const key = "raya.chief.verification"
  export const recovery = "raya.chief.foreground"
  const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const time = Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )
  export const Observation = Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literals(["foreground", "synthesis"]),
    userID: MessageID,
    messageID: MessageID,
    callID: text,
    requestSHA: hash,
    child: Schema.optional(
      Schema.Struct({ sessionID: SessionID, inputID: MessageID, messageID: MessageID, completedAt: time }),
    ),
    goal: Schema.Struct({
      status: Schema.Literals(["absent", "active", "paused", "blocked", "complete"]),
      digest: hash,
      intent: Schema.optional(text),
      revision: Schema.optional(text),
    }),
    at: time,
  })

  type Input = {
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "setMetadata">
    sessionID: SessionID
    messageID: MessageID
    callID: string
    request: string
  }
  /** Synthetic policy is not intent: only a current persisted dispatch or complete compaction chain bridges it. */
  function dispatch(
    rows: readonly SessionV1.WithParts[],
    user: SessionV1.WithParts | undefined,
    message: SessionV1.WithParts | undefined,
    goal?: RayaGoal.State,
  ) {
    if (!user || message?.info.role !== "assistant") return false
    const parent = message.info.parentID
    const latest = rows.findLast((row) => row.info.role === "user")
    if (latest?.info.id !== parent) return false
    if (parent === user.info.id) return true
    const intake = rows.find((row) => row.info.id === parent)
    if (intake && compacted(rows, user, intake, message, goal)) return true
    return (
      goal?.status === "active" &&
      goal.dispatch?.phase === "started" &&
      goal.dispatch.intent === (goal.intent ?? "unset") &&
      goal.dispatch.messageID === parent &&
      !!goal.dispatch.worker &&
      !!goal.inputs?.includes(parent) &&
      !!intake &&
      !RayaChief.requestText(intake.parts) &&
      RayaGoalContinuation.matches(intake, message.info.sessionID, parent, goal)
    )
  }

  /** A background continuation must be the exact authenticated current notice, never synthetic text alone. */
  function admitted(
    sessions: Pick<Session.Interface, "get" | "messages">,
    rows: readonly SessionV1.WithParts[],
    user: SessionV1.WithParts | undefined,
    message: SessionV1.WithParts | undefined,
    goal?: RayaGoal.State,
  ) {
    return Effect.gen(function* () {
      if (dispatch(rows, user, message, goal)) return true
      const latest = rows.findLast((row) => row.info.role === "user")
      if (
        !user ||
        user.info.role !== "user" ||
        !latest ||
        message?.info.role !== "assistant" ||
        message.info.agent !== "auto" ||
        message.info.parentID !== latest.info.id ||
        latest.info.id === user.info.id ||
        latest.info.sessionID !== message.info.sessionID ||
        user.info.sessionID !== message.info.sessionID
      )
        return false
      const proof = yield* ResultContract.load(sessions, {
        sessionID: message.info.sessionID,
        userID: latest.info.id,
        messageID: message.info.id,
      })
      if (!proof) return false
      const context = ResultContract.context(proof)
      return (
        context.input === user.info.id &&
        context.current === latest.info.id &&
        proof.sessionID === message.info.sessionID &&
        proof.request === RayaChief.requestText(user.parts)
      )
    })
  }

  function state(storage: Storage.Interface | undefined, sessionID: SessionID) {
    if (!storage) return Effect.succeed(undefined)
    return storage.read<unknown>(["raya", "goal", sessionID]).pipe(
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed(undefined),
      ),
      Effect.flatMap((raw) =>
        raw === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(RayaGoal.State)(raw),
      ),
    )
  }

  /** Read-only advertisement: execution still reserves the current invocation under its original gate. */
  export function saved(input: Omit<Input, "storage" | "callID" | "request"> & { storage?: Storage.Interface }) {
    return Effect.gen(function* () {
      const parent = yield* input.sessions.get(input.sessionID)
      const request = RayaChief.request(parent.metadata)
      const contract = RayaChief.follow(parent.metadata)
      if (!request || !(contract || RayaChief.continuation(parent.metadata))) return false
      const rows = yield* input.sessions.messages({ sessionID: input.sessionID })
      const user = rows.findLast((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
      const message = rows.find((row) => row.info.id === input.messageID)
      if (
        user?.info.role !== "user" ||
        (contract?.userID !== undefined && contract.userID !== user.info.id) ||
        RayaChief.requestText(user.parts) !== request ||
        message?.info.role !== "assistant" ||
        message.info.agent !== "auto" ||
        message.info.sessionID !== input.sessionID
      )
        return false
      const goal = message.info.parentID !== user.info.id ? yield* state(input.storage, input.sessionID) : undefined
      return yield* admitted(input.sessions, rows, user, message, goal)
    })
  }

  /** An unplanned foreground recovery retains its authenticated child, regardless of how the brief is reworded. */
  export function retained(
    input: Omit<Input, "storage" | "callID" | "request"> & {
      storage?: Storage.Interface
      background?: Pick<BackgroundJob.Interface, "get">
      agent: string
      planned: boolean
    },
  ) {
    return Effect.gen(function* () {
      if (input.agent !== "auto" || input.planned) return false
      const parent = yield* input.sessions.get(input.sessionID)
      if (RayaChief.phase(parent.metadata) === "done") return false
      const raw = parent.metadata?.[recovery] ?? parent.metadata?.[key]
      if (raw === undefined) return false
      const observation = yield* Schema.decodeUnknownEffect(Observation)(raw)
      if (observation.kind !== "foreground" || !observation.child) return false
      const goal = yield* state(input.storage, input.sessionID)
      const reading = observation.goal.status === "absent" && !goal
      if (!reading && (!goal || goal.status !== "active" || observation.goal.status !== "active")) return false
      const request = RayaChief.request(parent.metadata)
      const rows = yield* input.sessions.messages({ sessionID: input.sessionID })
      const user = rows.findLast((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
      const message = rows.find((row) => row.info.id === input.messageID)
      if (
        message?.info.role !== "assistant" ||
        message.info.agent !== "auto" ||
        !(yield* admitted(input.sessions, rows, user, message, goal))
      )
        throw new Error("Chief foreground recovery invocation is not current")
      if (!["goal", "verify"].includes(RayaChief.phase(parent.metadata))) return false
      if (!request || user?.info.id !== observation.userID || RayaChief.requestText(user.parts) !== request)
        return false
      if (observation.requestSHA !== digest({ tool: "request", state: request })) return false
      if (goal?.intent !== observation.goal.intent) return false
      const source = rows.find((row) => row.info.id === observation.messageID)
      const part = source?.parts.find((row) => row.type === "tool" && row.callID === observation.callID)
      const child = observation.child
      const session = yield* input.sessions.get(child.sessionID)
      const messages = yield* input.sessions.messages({ sessionID: child.sessionID })
      const initial = messages.find((row) => row.info.id === child.inputID)
      const terminal = messages.find((row) => row.info.id === child.messageID)
      const job = input.background ? yield* input.background.get(child.sessionID) : undefined
      const missing = ReadProof.missing(request, messages, child.inputID, child.completedAt)
      const refused =
        missing.length > 0 &&
        part?.type === "tool" &&
        part.state.status === "error" &&
        part.state.error.includes(
          "The completed worker has no successful invocation-bound Read of the owner's requested file(s):",
        )
      if (
        source?.info.role !== "assistant" ||
        source.info.agent !== "auto" ||
        part?.type !== "tool" ||
        part.tool !== "task" ||
        part.state.status === "pending" ||
        (part.state.status !== "running" && part.state.status !== "completed" && !refused) ||
        part.state.metadata?.sessionId !== child.sessionID ||
        part.state.metadata?.childMessageID !== child.inputID ||
        session.parentID !== input.sessionID ||
        initial?.info.role !== "user" ||
        terminal?.info.role !== "assistant" ||
        terminal.info.parentID !== child.inputID ||
        terminal.info.finish !== "stop" ||
        terminal.info.error ||
        terminal.info.time.completed !== child.completedAt ||
        terminal.parts.some((row) => row.type === "tool" && ["pending", "running"].includes(row.state.status)) ||
        (input.background !== undefined &&
          (!job ||
            job.metadata?.background === true ||
            !job.origins?.some((origin) => {
              if (!origin || origin.sessionID !== input.sessionID || origin.childSessionID !== child.sessionID)
                return false
              const owner = rows.find((row) => row.info.id === origin.messageID)
              const call = owner?.parts.find((row) => row.type === "tool" && row.callID === origin.callID)
              const initial = messages.find((row) => row.info.id === origin.childMessageID)
              if (
                owner?.info.role !== "assistant" ||
                owner.info.agent !== "auto" ||
                call?.type !== "tool" ||
                call.tool !== "task" ||
                initial?.info.role !== "user"
              )
                return false
              if (
                origin.messageID === observation.messageID &&
                origin.callID === observation.callID &&
                origin.childMessageID === child.inputID
              )
                return true
              return call.state.input.task_id === child.sessionID
            })))
      )
        throw new Error("Chief foreground recovery child lineage is invalid")
      if (job?.status === "running")
        return yield* Effect.fail(
          new Refusal(
            "task-recovery",
            "The retained Task is still running. Wait for that same Task to finish before reading its recovery state; do not start or replace its worker.",
          ),
        )
      if (reading && !missing.length) return false
      const correction = rows.some((row) =>
        row.parts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "update_goal" &&
            part.state.status === "completed" &&
            part.state.input.status === "complete" &&
            part.state.title === "Completion audit rejected" &&
            part.state.time.end >= observation.at,
        ),
      )
      const inspection = Schema.fromJsonString(Schema.Struct({ goal: RayaGoal.State }))
      const proof = Schema.Struct({
        version: Schema.Literal(1),
        sessionID: SessionID,
        messageID: MessageID,
        revision: Schema.optional(Schema.String),
        digest: hash,
      })
      const current = rows.findIndex((row) => row.info.id === input.messageID)
      const inspected =
        !!goal &&
        rows.slice(0, current).some(
          (row) =>
            row.info.role === "assistant" &&
            row.info.agent === "auto" &&
            goal?.inputs?.includes(row.info.parentID) &&
            row.parts.some((part) => {
              if (
                part.type !== "tool" ||
                part.tool !== "get_goal" ||
                part.sessionID !== input.sessionID ||
                part.messageID !== row.info.id ||
                part.state.status !== "completed" ||
                part.state.time.start < child.completedAt ||
                part.state.time.end < part.state.time.start ||
                part.state.time.end > message.info.time.created
              )
                return false
              const saved = Option.getOrUndefined(Schema.decodeUnknownOption(proof)(part.state.metadata[GoalGate.key]))
              const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(inspection)(part.state.output))
              return (
                saved !== undefined &&
                parsed !== undefined &&
                saved.sessionID === input.sessionID &&
                saved.messageID === row.info.id &&
                saved.revision === parsed.goal.revision &&
                saved.digest === GoalGate.observation(parsed.goal, input.sessionID, row.info.id).digest &&
                saved.digest === GoalGate.observation(goal, input.sessionID, row.info.id).digest
              )
            }),
        )
      return { taskID: child.sessionID, correction: correction || missing.length > 0, inspected: reading || inspected }
    })
  }

  export function reuse(
    input: Parameters<typeof retained>[0] & {
      background: Pick<BackgroundJob.Interface, "get">
      taskID?: string
      prompt?: string
      objective?: string
    },
  ) {
    return Effect.gen(function* () {
      const worker = yield* retained(input)
      if (!worker) return false
      if (input.taskID !== worker.taskID)
        return yield* Effect.fail(
          new Refusal(
            "task-recovery",
            `This current Chief request already has a completed worker. Continue or recover that same work with task_id="${worker.taskID}"; do not create a replacement child by rewording the brief. Distinct saved branches or a genuinely new routed request remain separate work. Put the ID in arguments.task_id, not only in the objective text. Supply a concrete continuation or correction in prompt or brief.objective.
${example(worker.taskID)}`,
          ),
        )
      if (!worker.inspected)
        return yield* Effect.fail(
          new Refusal(
            "task-recovery",
            "Inspect this original goal with get_goal in an earlier turn after the worker finishes before deciding whether a same-worker correction is needed. Do not issue get_goal and Task recovery together; read the completed inspection and its eligible evidence first. Do not repeat successful work or resume merely to repair citations.",
          ),
        )
      if (worker.correction && !input.prompt?.trim() && !input.objective?.trim())
        return yield* Effect.fail(
          new Refusal(
            "task-objective",
            `The retained worker's completion audit was rejected. Supply an explicit, nonblank correction in prompt or brief.objective and retain task_id="${worker.taskID}". The original request is not a correction.`,
          ),
        )
      return true
    })
  }

  /** Reserve verification only for the still-current admitted parent invocation. */
  export function reserve(
    input: Omit<Input, "storage" | "callID"> & {
      storage?: Storage.Interface
      callID?: string
      userID?: MessageID
      contract?: string
    },
  ) {
    return Effect.gen(function* () {
      const parent = yield* input.sessions.get(input.sessionID)
      const rows = yield* input.sessions.messages({ sessionID: input.sessionID })
      const user = rows.findLast((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
      const message = rows.find((row) => row.info.id === input.messageID)
      const part = message?.parts.find((part) => part.type === "tool" && part.callID === input.callID)
      const goal =
        message?.info.role === "assistant" && message.info.parentID !== user?.info.id
          ? yield* state(input.storage, input.sessionID)
          : undefined
      const current = yield* admitted(input.sessions, rows, user, message, goal)
      if (
        !["task", "goal", "verify"].includes(RayaChief.phase(parent.metadata)) ||
        RayaChief.request(parent.metadata) !== input.request ||
        (input.contract !== undefined && ChiefRefinement.fingerprint(parent.metadata) !== input.contract) ||
        user?.info.id !== input.userID ||
        (user && RayaChief.requestText(user.parts) !== input.request) ||
        (input.callID !== undefined &&
          (!input.callID ||
            !input.userID ||
            message?.info.role !== "assistant" ||
            message.info.agent !== "auto" ||
            !current ||
            part?.type !== "tool" ||
            part.tool !== "task" ||
            part.state.status !== "running"))
      )
        throw new Error(
          `Chief verification reservation changed (${
            !["task", "goal", "verify"].includes(RayaChief.phase(parent.metadata))
              ? "phase"
              : RayaChief.request(parent.metadata) !== input.request
                ? "request"
                : input.contract !== undefined && ChiefRefinement.fingerprint(parent.metadata) !== input.contract
                  ? "contract"
                  : user?.info.id !== input.userID
                    ? "user"
                    : user && RayaChief.requestText(user.parts) !== input.request
                      ? "user-text"
                      : !input.callID || !input.userID
                        ? "invocation"
                        : message?.info.role !== "assistant" || message.info.agent !== "auto"
                          ? "message"
                          : !current
                            ? "dispatch"
                            : part?.type !== "tool" || part.tool !== "task"
                              ? "tool"
                              : `tool-state:${part.state.status}`
          })`,
        )
      const clean = Object.fromEntries(
        Object.entries(parent.metadata ?? {}).filter(([key]) => key !== RayaChief.pendingKey),
      )
      yield* input.sessions.setMetadata({
        sessionID: input.sessionID,
        metadata: { ...clean, [RayaChief.phaseKey]: "verify" },
      })
    }).pipe(gate.withLock(input.sessionID))
  }

  type Child = { background: Pick<BackgroundJob.Interface, "get">; childID: SessionID; inputID: MessageID }

  function inspect(
    input: Input,
    goals: Pick<ReturnType<typeof RayaGoal.make>, "get">,
    kind: "foreground" | "synthesis",
    child?: Child,
  ) {
    return Effect.gen(function* () {
      // The real reader may prune through goal mutation locks; perform it before entering that lock.
      const observed = yield* goals.get(input.sessionID)
      const fingerprint = digest({ tool: "goal", state: observed ?? null })
      return yield* mutation(
        input.storage,
        input.sessionID,
        Effect.gen(function* () {
          const raw = yield* input.storage.read<unknown>(["raya", "goal", input.sessionID]).pipe(
            Effect.catchIf(
              (err) => Storage.NotFoundError.isInstance(err),
              () => Effect.succeed(undefined),
            ),
          )
          const goal = raw === undefined ? undefined : yield* Schema.decodeUnknownEffect(RayaGoal.State)(raw)
          if (digest({ tool: "goal", state: goal ?? null }) !== fingerprint)
            throw new Error("Chief goal changed during verification")
          const parent = yield* input.sessions.get(input.sessionID)
          if (
            (kind === "foreground"
              ? RayaChief.phase(parent.metadata) !== "verify"
              : !["task", "goal"].includes(RayaChief.phase(parent.metadata))) ||
            RayaChief.request(parent.metadata) !== input.request
          )
            throw new Error("Chief verification generation changed")
          const rows = yield* input.sessions.messages({ sessionID: input.sessionID })
          const user = rows.findLast((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
          const message = rows.find((row) => row.info.id === input.messageID)
          if (
            !user ||
            RayaChief.requestText(user.parts) !== input.request ||
            message?.info.role !== "assistant" ||
            message.info.agent !== "auto" ||
            !(yield* admitted(input.sessions, rows, user, message, goal))
          )
            throw new Error("Chief verification parent input changed")
          const part = message.parts.find((part) => part.type === "tool" && part.callID === input.callID)
          if (
            part?.type !== "tool" ||
            part.tool !== (kind === "foreground" ? "task" : "chief_synthesize") ||
            !["running", "completed"].includes(part.state.status)
          )
            throw new Error("Chief verification invocation is not current")
          const evidence = child
            ? yield* Effect.gen(function* () {
                const job = yield* child.background.get(child.childID)
                if (
                  job?.status !== "completed" ||
                  job.metadata?.background === true ||
                  !job.origins?.some(
                    (origin) =>
                      origin?.sessionID === input.sessionID &&
                      origin.messageID === input.messageID &&
                      origin.callID === input.callID &&
                      origin.childSessionID === child.childID &&
                      origin.childMessageID === child.inputID,
                  )
                )
                  throw new Error("Chief verification child job is not completed")
                const session = yield* input.sessions.get(child.childID)
                const messages = yield* input.sessions.messages({ sessionID: child.childID })
                const initial = messages.find((row) => row.info.id === child.inputID)
                const terminal = messages.findLast((row) => row.info.role === "assistant")
                if (
                  session.parentID !== input.sessionID ||
                  initial?.info.role !== "user" ||
                  terminal?.info.role !== "assistant" ||
                  terminal.info.parentID !== child.inputID ||
                  terminal.info.error ||
                  terminal.info.finish !== "stop" ||
                  terminal.info.time.completed === undefined ||
                  terminal.parts.some(
                    (part) => part.type === "tool" && ["pending", "running"].includes(part.state.status),
                  )
                )
                  throw new Error("Chief verification child terminal is not successful")
                if (
                  (part.state.status === "running" || part.state.status === "completed") &&
                  (part.state.metadata?.sessionId !== child.childID ||
                    part.state.metadata?.childMessageID !== child.inputID)
                )
                  throw new Error("Chief verification child input does not match invocation")
                return {
                  sessionID: child.childID,
                  inputID: child.inputID,
                  messageID: terminal.info.id,
                  completedAt: terminal.info.time.completed,
                  missing: ReadProof.missing(input.request, messages, child.inputID, terminal.info.time.completed),
                }
              })
            : undefined
          const at = Date.now()
          if (evidence && evidence.completedAt > at) throw new Error("Chief verification child time is invalid")
          const observation = yield* Schema.decodeUnknownEffect(Observation)({
            version: 1,
            kind,
            userID: user.info.id,
            messageID: input.messageID,
            callID: input.callID,
            requestSHA: digest({ tool: "request", state: input.request }),
            ...(evidence ? { child: evidence } : {}),
            goal: {
              status: goal?.status ?? "absent",
              digest: fingerprint,
              ...(goal?.intent ? { intent: goal.intent } : {}),
              ...(goal?.revision ? { revision: goal.revision } : {}),
            },
            at,
          })
          // Preserve the freshest metadata; input writes and goal publications remain cooperatively fenced.
          const current = yield* input.sessions.get(input.sessionID)
          const final = yield* input.sessions.messages({ sessionID: input.sessionID })
          const latest = final.findLast((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
          if (
            (kind === "foreground"
              ? RayaChief.phase(current.metadata) !== "verify"
              : RayaChief.phase(current.metadata) !== RayaChief.phase(parent.metadata)) ||
            RayaChief.request(current.metadata) !== input.request ||
            latest?.info.id !== user.info.id ||
            !(yield* admitted(
              input.sessions,
              final,
              latest,
              final.find((row) => row.info.id === input.messageID),
              goal,
            ))
          )
            throw new Error("Chief verification publication generation changed")
          yield* input.sessions.setMetadata({
            sessionID: input.sessionID,
            metadata: {
              ...current.metadata,
              [key]: observation,
              ...(kind === "foreground" ? { [recovery]: observation } : {}),
              [RayaChief.phaseKey]: evidence?.missing.length
                ? "goal"
                : !goal || goal.status === "complete"
                  ? "done"
                  : "goal",
            },
          })
          if (evidence?.missing.length)
            return yield* Effect.fail(
              new Refusal(
                "task-recovery",
                `The completed worker has no successful invocation-bound Read of the owner's requested file(s): ${evidence.missing.join(", ")}. Do not accept or repeat its unverified narrative. Continue the same worker with arguments.task_id="${evidence.sessionID}" and a concrete correction to read those files and report their actual contents. Do not create another child or invent a result.`,
              ),
            )
          return observation
        }),
      ).pipe(gate.withLock(input.sessionID))
    })
  }

  export const foreground = (
    input: Input & Child & { sessions: Pick<Session.Interface, "get" | "messages" | "setMetadata" | "children"> },
  ) => inspect(input, RayaGoal.make({ storage: input.storage, sessions: input.sessions }), "foreground", input)
  export const synthesis = (input: Input & { goals: Pick<ReturnType<typeof RayaGoal.make>, "get"> }) =>
    inspect(input, input.goals, "synthesis")
}
