import { Effect, Schema } from "effect"
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

export namespace ChiefVerification {
  export const key = "raya.chief.verification"
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
  /** Only the durable automatic compaction producer chain retains the original authored request. */
  function compact(
    rows: readonly SessionV1.WithParts[],
    user: SessionV1.WithParts,
    intake: SessionV1.WithParts,
    message: SessionV1.WithParts,
    goal?: RayaGoal.State,
  ) {
    if (
      (goal && goal.status !== "active") ||
      user.info.role !== "user" ||
      intake.info.role !== "user" ||
      message.info.role !== "assistant"
    )
      return false
    const idx = rows.findIndex((row) => row.info.id === intake.info.id)
    const summary = rows[idx - 1]
    if (
      summary?.info.role !== "assistant" ||
      !summary.info.summary ||
      summary.info.agent !== "compaction" ||
      summary.info.finish !== "stop" ||
      summary.info.error ||
      !summary.info.time.completed ||
      summary.info.time.completed > intake.info.time.created
    )
      return false
    const origin = summary.info.parentID
    const parent = rows.findIndex((row) => row.info.id === origin)
    const authored = rows.findIndex((row) => row.info.id === user.info.id)
    const marker = rows[parent]
    if (
      authored < 0 ||
      parent <= authored ||
      parent >= idx - 1 ||
      marker?.info.role !== "user" ||
      marker.info.agent !== user.info.agent ||
      intake.info.agent !== user.info.agent ||
      marker.info.model.providerID !== user.info.model.providerID ||
      marker.info.model.modelID !== user.info.model.modelID ||
      intake.info.model.providerID !== user.info.model.providerID ||
      intake.info.model.modelID !== user.info.model.modelID ||
      marker.parts.length !== 1 ||
      marker.parts[0]?.type !== "compaction" ||
      !marker.parts[0].auto ||
      marker.parts[0].overflow === true ||
      rows.slice(authored + 1, idx).some((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts)) ||
      !summary.parts.some((part) => part.type === "text" && !!part.text.trim()) ||
      intake.parts.length !== 1
    )
      return false
    const part = intake.parts[0]
    return (
      part?.type === "text" &&
      part.synthetic === true &&
      part.ignored !== true &&
      part.metadata?.compaction_continue === true &&
      part.text ===
        "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." &&
      [user, marker, summary, intake, message].every((row) => row.info.sessionID === message.info.sessionID)
    )
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
    if (intake && compact(rows, user, intake, message, goal)) return true
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
      return dispatch(rows, user, message, goal)
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
            !dispatch(rows, user, message, goal) ||
            part?.type !== "tool" ||
            part.tool !== "task" ||
            part.state.status !== "running"))
      )
        throw new Error("Chief verification reservation changed")
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
            !dispatch(rows, user, message, goal)
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
            !dispatch(
              final,
              latest,
              final.find((row) => row.info.id === input.messageID),
              goal,
            )
          )
            throw new Error("Chief verification publication generation changed")
          yield* input.sessions.setMetadata({
            sessionID: input.sessionID,
            metadata: {
              ...current.metadata,
              [key]: observation,
              [RayaChief.phaseKey]: !goal || goal.status === "complete" ? "done" : "goal",
            },
          })
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
