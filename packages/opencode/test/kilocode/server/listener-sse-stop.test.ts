import { expect, test } from "bun:test"
import { Server } from "../../../src/server/server"
import { withTimeout } from "../../../src/util/timeout"

test("forced production listener shutdown joins a live SSE without caching a timeout interruption", async () => {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const stream: { reader?: ReadableStreamDefaultReader<Uint8Array> } = {}
  const outcome = await Promise.allSettled([
    (async () => {
      const response = await fetch(new URL("/global/event", listener.url))
      const reader = response.body!.getReader()
      stream.reader = reader
      expect(response.status).toBe(200)
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
      await listener.quiesce()
      await withTimeout(listener.stop(true), 10_000, "Original production listener did not retire")
      await listener.stop(true)
      expect((await Promise.allSettled([fetch(new URL("/global/health", listener.url))]))[0].status).toBe("rejected")
    })(),
  ])
  const joined = await Promise.allSettled([stream.reader?.cancel(), listener.stop(true)])
  const errors = [...outcome, ...joined].flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Original listener execution or cleanup failed")
}, 20_000)
