import { validate, type request } from "./worker-identity"
import { ProfileParticipants } from "../../profile-participants"

/** A correlated RPC acknowledgment and observed worker exit are both required for confirmation. */
export function parentStop(input: {
  worker: Worker
  shutdown: () => Promise<unknown>
  request: ReturnType<typeof request>
  detach: () => void
  timeout?: number
}) {
  const timeout = input.timeout ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("TUI worker shutdown deadline is invalid")
  const exited = Promise.withResolvers<void>()
  const broken = Promise.withResolvers<Error>()
  const close = (event: Event) => {
    if (!("code" in event) || event.code !== 0 || !("wasClean" in event) || event.wasClean !== true) {
      const code = "code" in event ? String(event.code) : "unknown"
      broken.resolve(new Error(`TUI worker exited without clean confirmation (code ${code})`))
      return
    }
    exited.resolve()
  }
  const error = (event: ErrorEvent) =>
    broken.resolve(event.error instanceof Error ? event.error : new Error(event.message))
  input.worker.addEventListener("close", close)
  input.worker.addEventListener("error", error)
  let closing: Promise<ReturnType<typeof validate>> | undefined
  return () => {
    return (closing ??= Promise.resolve().then(async () => {
      const timer: { value?: ReturnType<typeof setTimeout> } = {}
      const deadline = new Promise<never>((_, reject) => {
        timer.value = setTimeout(
          () => reject(new Error("TUI worker shutdown timed out; forced termination cannot confirm cleanup")),
          timeout,
        )
      })
      try {
        input.detach()
        const [reply] = await Promise.race([
          Promise.all([
            Promise.resolve()
              .then(input.shutdown)
              .then((value) => validate(value, input.request)),
            exited.promise,
          ]),
          broken.promise.then((err) => {
            throw err
          }),
          deadline,
        ])
        ProfileParticipants.remember(reply)
        return reply
      } catch (err) {
        try {
          input.worker.terminate()
        } catch (failure) {
          return Promise.reject(
            new AggregateError([err, failure], "TUI worker shutdown and forced termination failed", { cause: err }),
          )
        }
        throw err
      } finally {
        clearTimeout(timer.value)
        input.worker.removeEventListener("close", close)
        input.worker.removeEventListener("error", error)
      }
    }))
  }
}
