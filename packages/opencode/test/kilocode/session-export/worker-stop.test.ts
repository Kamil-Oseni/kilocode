import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { stopExportWorker } from "@/kilocode/session-export/worker-stop"
import * as Identity from "@/kilocode/session-export/worker-identity"

for (const mode of [
  "clean",
  "wrong",
  "generation",
  "run",
  "role",
  "version",
  "hash",
  "malformed",
  "relative",
  "duplicate",
  "globalzero",
  "missing",
  "noexit",
  "badexit",
  "error",
  "refused",
])
  test(`actual worker exit confirmation requires correlated ACK and clean exit: ${mode}`, async () => {
    const worker = new Worker(new URL("./fixtures/worker-stop.ts", import.meta.url), { argv: [mode] })
    const ready = Promise.withResolvers<void>()
    let closed = false
    worker.addEventListener("message", (event: MessageEvent<{ kind: string }>) => {
      if (event.data.kind === "ready") ready.resolve()
    })
    worker.addEventListener("close", () => {
      closed = true
    })
    try {
      await ready.promise
      const result = stopExportWorker(worker, Identity.request(Identity.spawn(crypto.randomUUID())), 150)
      if (mode === "clean") {
        await result
        expect(closed).toBe(true)
        return
      }
      if (mode === "refused") {
        const err = await result.catch((err: unknown) => err)
        expect(err).toBeInstanceOf(Error)
        assert.ok(err instanceof Error && err.cause instanceof AggregateError)
        expect(err.cause.errors.map(String)).toEqual(["Error: actual retained cleanup failure"])
        return
      }
      await assert.rejects(
        result,
        mode === "error"
          ? /actual export worker error/
          : mode === "refused"
            ? /actual refusal/
            : mode === "badexit"
              ? /without clean confirmation/
              : ["generation", "run", "role", "version"].includes(mode)
                ? /identity does not match/
                : ["hash", "malformed", "relative", "duplicate", "globalzero"].includes(mode)
                  ? /receipt is invalid/
                  : /timed out/,
      )
    } finally {
      if (!closed) worker.terminate()
    }
  }, 5_000)

test("invalid worker stop deadlines are rejected before any listener is installed", () => {
  const worker = new Worker(new URL("./fixtures/worker-stop.ts", import.meta.url), { argv: ["clean"] })
  try {
    for (const timeout of [NaN, Infinity, 0, -1, 1.5, 60_001])
      expect(() => stopExportWorker(worker, Identity.request(Identity.spawn(crypto.randomUUID())), timeout)).toThrow(
        "deadline is invalid",
      )
  } finally {
    worker.terminate()
  }
})
