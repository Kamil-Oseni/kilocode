import { accept, validate } from "./worker-identity"
import type { ShutdownRequest, ShutdownReply } from "./worker/ipc"
import { ProfileParticipants } from "../cli/profile-participants"

/** Confirmation requires both the exact cleanup reply and an observed clean worker exit. */
export function stopExportWorker(worker: Worker, expected: ShutdownRequest, timeout: number): Promise<ShutdownReply> {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    throw new Error("Session export worker shutdown deadline is invalid")
  accept(expected, expected)
  const acknowledged = Promise.withResolvers<ShutdownReply>()
  const exited = Promise.withResolvers<void>()
  const broken = Promise.withResolvers<Error>()
  const message = (event: MessageEvent<unknown>) => {
    const msg = event.data
    if (!msg || typeof msg !== "object" || !("requestID" in msg) || msg.requestID !== expected.requestID) return
    try {
      accept(msg, expected)
    } catch (err) {
      broken.resolve(new Error("Session export shutdown acknowledgment identity does not match", { cause: err }))
      return
    }
    if ("kind" in msg && msg.kind === "shutdown_refused") {
      const reason = "reason" in msg && typeof msg.reason === "string" ? msg.reason : "unknown"
      const failures =
        "failures" in msg && Array.isArray(msg.failures) && msg.failures.every((item) => typeof item === "string")
          ? new AggregateError(
              msg.failures.map((item) => new Error(item)),
              "Session export worker cleanup failures",
            )
          : undefined
      broken.resolve(new Error(`Session export shutdown refused: ${reason}`, { cause: failures }))
    }
    if ("kind" in msg && msg.kind === "shutdown_done") {
      try {
        acknowledged.resolve(validate(msg, expected))
      } catch (err) {
        broken.resolve(new Error("Session export shutdown receipt is invalid", { cause: err }))
      }
    }
  }
  const close = (event: Event) => {
    if (!("code" in event) || event.code !== 0 || !("wasClean" in event) || event.wasClean !== true) {
      broken.resolve(new Error("Session export worker exited without clean confirmation"))
      return
    }
    exited.resolve()
  }
  const error = (event: ErrorEvent) =>
    broken.resolve(new Error(`Session export worker failed: ${event.message}`, { cause: event.error }))
  worker.addEventListener("message", message)
  worker.addEventListener("close", close)
  worker.addEventListener("error", error)
  const timer: { value?: ReturnType<typeof setTimeout> } = {}
  const task = Promise.resolve().then(async () => {
    const deadline = new Promise<never>((_, reject) => {
      timer.value = setTimeout(
        () =>
          reject(
            new Error(
              "Session export shutdown timed out waiting for correlated acknowledgment and natural worker exit",
            ),
          ),
        timeout,
      )
    })
    worker.postMessage({ kind: "shutdown", timeoutMs: timeout, ...expected })
    const result = await Promise.race([
      Promise.all([acknowledged.promise, exited.promise]),
      broken.promise.then((err) => {
        throw err
      }),
      deadline,
    ])
    ProfileParticipants.remember(result[0])
    return result[0]
  })
  return task.finally(() => {
    clearTimeout(timer.value)
    worker.removeEventListener("message", message)
    worker.removeEventListener("close", close)
    worker.removeEventListener("error", error)
  })
}
