import { expect, test } from "bun:test"
import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createConnection } from "node:net"
import { terminal, track } from "../../../src/kilocode/server/event-drain"

async function listener() {
  const server = createServer()
  const owner = track(server)
  const accepted = Promise.withResolvers<{ source: IncomingMessage; response: ServerResponse }>()
  server.on("request", (source, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write("data: connected\n\n")
    accepted.resolve({ source, response })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected an original TCP listener")
  const socket = createConnection(address.port, "127.0.0.1")
  const chunks: Buffer[] = []
  socket.on("data", (chunk) => chunks.push(chunk))
  const closed = once(socket, "close")
  await once(socket, "connect")
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
  const request = await accepted.promise
  return {
    owner,
    request,
    socket,
    closed,
    text: () => Buffer.concat(chunks).toString(),
    async close() {
      owner.close()
      const joined = once(server, "close")
      request.response.end()
      server.close()
      socket.destroy()
      server.closeAllConnections()
      await closed
      await joined
    },
  }
}

test("terminal drain joins the original writer and retains one shutdown promise", async () => {
  const current = await listener()
  try {
    terminal(current.request.source)
    const joined = current.owner.drain()
    expect(current.owner.drain()).toBe(joined)
    let finished = false
    void joined.then(() => {
      finished = true
    })
    await Bun.sleep(10)
    expect(finished).toBe(false)
    current.request.response.end("data: disposed\n\n")
    await current.closed
    expect(current.text()).toContain("data: connected\n\n")
    expect(current.text()).toContain("data: disposed\n\n")
    await joined
    expect(current.request.response.writableFinished).toBe(true)
    expect(finished).toBe(true)
  } finally {
    await current.close()
  }
})

test("a terminal socket closing before writer completion retains its original failure", async () => {
  const current = await listener()
  try {
    terminal(current.request.source)
    const joined = current.owner.drain()
    const rejected = joined.then(
      () => undefined,
      (err: unknown) => err,
    )
    current.request.response.socket?.destroy()
    const outcome = await Promise.race([rejected, Bun.sleep(500).then(() => "Original disconnect was not observed")])
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(String(outcome)).toContain("Terminal event delivery failed")
    expect(current.owner.drain()).toBe(joined)
    await current.closed
    expect(current.request.response.writableFinished).toBe(false)
  } finally {
    await current.close()
  }
})

test("ordinary live requests do not block the terminal event drain", async () => {
  const current = await listener()
  try {
    await current.owner.drain()
    expect(current.request.response.writableFinished).toBe(false)
    current.request.response.end()
    await current.closed
    expect(current.text()).toContain("data: connected\n\n")
  } finally {
    await current.close()
  }
})
