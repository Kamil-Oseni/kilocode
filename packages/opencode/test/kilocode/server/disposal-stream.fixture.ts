import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Server } from "../../../src/server/server"
import { waitForServe } from "../../../src/kilocode/cli/serve-shutdown"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.env.RAYA_RETIREMENT_PROFILE
assert(root)
const directory = join(root, "workspace")
await mkdir(directory)
const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const response = await fetch(new URL("/event", server.url), { headers: { "x-kilo-directory": directory } })
assert.equal(response.status, 200)
assert(response.body)
const reader = response.body.getReader()
const ready = Promise.withResolvers<void>()
const events: string[] = []
const streamed = (async () => {
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const end = buffer.indexOf("\n\n")
      if (end < 0) break
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = frame.split("\n").find((line) => line.startsWith("data:"))
      if (!data) continue
      const event = JSON.parse(data.slice(5).trim())
      events.push(event.type)
      if (event.type === "server.connected") ready.resolve()
    }
  }
})()
const observed = streamed.then(
  () => undefined,
  (err: unknown) => err,
)
try {
  await ready.promise
  const initial = process.listenerCount("SIGTERM")
  const closing = waitForServe(server)
  const deadline = Date.now() + 5_000
  while (process.listenerCount("SIGTERM") === initial) {
    assert(Date.now() < deadline, "The original shutdown owner must register its signal")
    await Bun.sleep(5)
  }
  process.emit("SIGTERM")
  await closing
  const error = await observed
  assert.equal(error, undefined, "The original SSE must reach ordinary EOF")
  assert.equal(events[0], "server.connected")
  assert.equal(events.at(-1), "server.instance.disposed")
  assert.equal(events.filter((event) => event === "server.instance.disposed").length, 1)
  assert(!events.includes("server.resync_required"))
} catch (err) {
  process.exitCode = 1
  console.error(err)
} finally {
  // The CLI's original outer owner retires every realized runtime and database,
  // then closes log writers before publishing completion and terminating.
  await finish([], () =>
    Bun.write(join(root, "receipt.json"), JSON.stringify({ passed: true, events, originalStreamJoined: true })).then(
      () => undefined,
    ),
  )
}
