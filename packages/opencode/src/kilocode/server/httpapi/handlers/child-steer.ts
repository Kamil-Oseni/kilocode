import { Effect, Exit, Fiber, Option, Scope } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { notFound } from "@/server/routes/instance/httpapi/errors"
import { ChildSteerConflictError, type ChildSteerPayload } from "../groups/child-steer"
import type { SessionID } from "@/session/schema"

type Input = {
  params: { parentSessionID: SessionID; childSessionID: SessionID }
  payload: typeof ChildSteerPayload.Type
}

function text(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => (part.type === "text" && part.synthetic !== true ? [part.text] : []))
    .join("\n")
}

export const childSteerHandlers = HttpApiBuilder.group(InstanceHttpApi, "child-steer", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const runs = yield* SessionRunState.Service
    const scope = yield* Scope.Scope
    const claims = new Map<string, { text: string; done: Promise<boolean>; resolve: (accepted: boolean) => void }>()

    const load = (id: SessionID) => sessions.get(id).pipe(Effect.mapError(() => notFound(`Session not found: ${id}`)))
    const receipt = (input: Input, replayed: boolean) => ({
      parentSessionID: input.params.parentSessionID,
      childSessionID: input.params.childSessionID,
      messageID: input.payload.messageID,
      replayed,
    })
    const replay = Effect.fn("ChildSteer.replay")(function* (input: Input) {
      const prior = yield* sessions
        .findMessage(
          input.params.childSessionID,
          (message) => message.info.role === "user" && message.info.id === input.payload.messageID,
        )
        .pipe(Effect.mapError(() => notFound(`Session not found: ${input.params.childSessionID}`)))
      if (Option.isNone(prior)) return false
      if (text(prior.value) === input.payload.text) return true
      return yield* new ChildSteerConflictError({
        code: "changed-replay",
        message: `Message ${input.payload.messageID} was already admitted with different text.`,
      })
    })
    const failed = (message = "The child steering instruction could not be admitted.") =>
      new ChildSteerConflictError({ code: "admission-failed", message })
    const awaitAdmission = Effect.fn("ChildSteer.awaitAdmission")(function* (
      input: Input,
      fiber: Fiber.Fiber<SessionV1.WithParts, Error>,
    ) {
      const persisted = Effect.gen(function* () {
        while (true) {
          if (yield* replay(input)) return { type: "persisted" as const }
          yield* Effect.sleep("10 millis")
        }
      })
      const ended = Fiber.await(fiber).pipe(Effect.map((exit) => ({ type: "ended" as const, exit })))
      const timeout = Effect.sleep("10 seconds").pipe(Effect.as({ type: "timeout" as const }))
      const result = yield* Effect.raceFirst(Effect.raceFirst(persisted, ended), timeout)
      if (result.type === "persisted") return true
      if (result.type === "timeout") yield* Fiber.interrupt(fiber)
      // A very short successful prompt can finish beside the persistence poll.
      // A timed-out prompt can also persist as interruption lands, so recheck
      // durable state before treating the dispatch as pre-admission failure.
      if (yield* replay(input)) return true
      if (result.type === "ended" && Exit.isFailure(result.exit))
        yield* Effect.logError("child steering failed before admission", result.exit.cause)
      return false
    })
    const steer = Effect.fn("ChildSteer.steer")(function* (input: Input) {
      if (input.params.parentSessionID === input.params.childSessionID)
        return yield* notFound("Direct child session not found.")

      const instance = yield* InstanceState.context
      const parent = yield* load(input.params.parentSessionID)
      const child = yield* load(input.params.childSessionID)
      if (
        child.parentID !== parent.id ||
        child.projectID !== parent.projectID ||
        parent.projectID !== instance.project.id ||
        child.directory !== instance.directory ||
        parent.directory !== instance.directory
      )
        return yield* notFound("Direct child session not found.")

      if (yield* replay(input)) return receipt(input, true)

      const observed = yield* runs.inspect(child.id)
      if (observed.phase !== "running" || !observed.id)
        return yield* new ChildSteerConflictError({
          code: "inactive",
          message: "The child session is no longer running.",
        })

      // The process-local claim closes concurrent HTTP races. Once the owner
      // projects the immutable user message, replay remains durable across restarts.
      const key = JSON.stringify([instance.directory, parent.id, child.id, input.payload.messageID])
      const claimed = claims.get(key)
      if (claimed) {
        if (claimed.text !== input.payload.text)
          return yield* new ChildSteerConflictError({
            code: "changed-replay",
            message: `Message ${input.payload.messageID} is already being admitted with different text.`,
          })
        if (!(yield* Effect.promise(() => claimed.done))) return yield* failed()
        return receipt(input, true)
      }
      const pending = Promise.withResolvers<boolean>()
      claims.set(key, { text: input.payload.text, done: pending.promise, resolve: pending.resolve })
      return yield* Effect.gen(function* () {
        const current = yield* runs.inspect(child.id)
        if (current.phase !== "running" || current.id !== observed.id)
          return yield* new ChildSteerConflictError({
            code: "stale-run",
            message: "The child session changed before steering could be admitted.",
          })

        const fiber = yield* prompts
          .prompt({
            sessionID: child.id,
            messageID: input.payload.messageID,
            parts: [{ type: "text", text: input.payload.text }],
          })
          .pipe(Effect.forkIn(scope, { startImmediately: true }))
        const admitted = yield* awaitAdmission(input, fiber)
        pending.resolve(admitted)
        if (!admitted) return yield* failed()
        return receipt(input, false)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (claims.get(key)?.done === pending.promise) claims.delete(key)
            pending.resolve(false)
          }),
        ),
      )
    })

    return handlers.handle("steer", steer)
  }),
)
