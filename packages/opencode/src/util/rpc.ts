type Definition = {
  [method: string]: (input: any) => any
}

// kilocode_change start - provide request input to Kilo-owned admission without changing existing callbacks
export function listen(rpc: Definition, admit?: (method: string, work: () => unknown, input: unknown) => unknown) {
  // kilocode_change end
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      // kilocode_change start - rejected worker calls must settle clients instead of leaking pending requests
      try {
        const work = () => rpc[parsed.method](parsed.input)
        const result = await (admit ? admit(parsed.method, work, parsed.input) : work())
        postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      } catch (err) {
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 2048)
        postMessage(JSON.stringify({ type: "rpc.error", error, id: parsed.id }))
      }
      // kilocode_change end
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>() // kilocode_change
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    // kilocode_change start - preserve success and failure responses with joined pending entries
    if (parsed.type === "rpc.result") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        resolve.resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.error") {
      const entry = pending.get(parsed.id)
      if (entry) {
        entry.reject(new Error(parsed.error))
        pending.delete(parsed.id)
      }
    }
    // kilocode_change end
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      // kilocode_change start
      return new Promise((resolve, reject) => {
        // kilocode_change end
        pending.set(requestId, { resolve, reject }) // kilocode_change
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
