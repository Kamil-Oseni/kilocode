import type { IncomingMessage, Server, ServerResponse } from "node:http"

type Entry = {
  terminal: boolean
  joined: Promise<void>
}

const entries = new WeakMap<object, Entry>()

export function terminal(source: object) {
  const entry = entries.get(source)
  if (entry) entry.terminal = true
}

/** Join the original native response writers that have accepted a terminal SSE frame. */
export function track(server: Server) {
  const active = new Set<Entry>()
  const failures: Error[] = []
  const request = (source: IncomingMessage, response: ServerResponse) => {
    const done = Promise.withResolvers<void>()
    const entry: Entry = { terminal: false, joined: done.promise }
    const socket = response.socket
    entries.set(source, entry)
    active.add(entry)
    const finish = () => {
      if (!active.delete(entry)) return
      entries.delete(source)
      response.off("finish", finish)
      response.off("close", finish)
      socket?.off("close", finish)
      if (entry.terminal && !response.writableFinished)
        failures.push(new Error("Terminal event response closed before its original writer finished"))
      done.resolve()
    }
    response.once("finish", finish)
    response.once("close", finish)
    // Observe the original socket as well as the response, retaining transport
    // loss before writer completion as failure.
    socket?.once("close", finish)
  }
  server.on("request", request)
  let pending: Promise<void> | undefined
  return {
    drain() {
      return (pending ??= (async () => {
        await Promise.all([...active].filter((entry) => entry.terminal).map((entry) => entry.joined))
        if (failures.length) throw new AggregateError(failures, "Terminal event delivery failed")
      })())
    },
    close() {
      server.off("request", request)
    },
  }
}
