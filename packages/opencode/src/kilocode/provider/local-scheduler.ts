type Fetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>
type Limits = { active: number; count: number; bytes: number; age: number }
type Job = {
  input: Parameters<Fetch>[0]
  init?: Parameters<Fetch>[1]
  fetcher: Fetch
  bytes: number
  phase: "queued" | "fetching" | "streaming" | "cancelling" | "closed"
  controller: AbortController
  signal?: AbortSignal
  abort?: () => void
  timer?: ReturnType<typeof setTimeout>
  reader?: ReadableStreamDefaultReader<Uint8Array>
  output?: ReadableStreamDefaultController<Uint8Array>
  cancellation?: Promise<void>
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

export class LocalInferenceError extends Error {
  readonly isRetryable = false
  constructor(
    readonly code: "queue-full" | "queue-timeout" | "body-unknown" | "init-unknown",
    message: string,
  ) {
    super(message)
    this.name = "LocalInferenceError"
  }
}

/** Scheduling is explicit: a loopback endpoint may be a remote-provider proxy. */
export function localConfig(options: Readonly<Record<string, unknown>>) {
  return { enabled: options.localInference === true }
}

function size(input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) {
  const body = init?.body
  if (body === undefined && input instanceof Request && input.body) return undefined
  if (body == null) return 0
  if (typeof body === "string") return Buffer.byteLength(body)
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof Blob) return undefined // A slice may retain a much larger backing store.
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString())
  return undefined
}

function retain(input: Parameters<Fetch>[0], init: Parameters<Fetch>[1], capacity: number) {
  const opts: NonNullable<Parameters<Fetch>[1]> = {}
  const enums: Record<string, readonly string[]> = {
    cache: ["default", "force-cache", "no-cache", "no-store", "only-if-cached", "reload"],
    credentials: ["include", "omit", "same-origin"],
    mode: ["cors", "navigate", "no-cors", "same-origin"],
    priority: ["auto", "high", "low"],
    redirect: ["error", "follow", "manual"],
    referrerPolicy: [
      "",
      "no-referrer",
      "no-referrer-when-downgrade",
      "origin",
      "origin-when-cross-origin",
      "same-origin",
      "strict-origin",
      "strict-origin-when-cross-origin",
      "unsafe-url",
    ],
    duplex: ["half"],
    protocol: ["http2", "http1.1", "h2", "h1"],
  }
  const strings = new Set(["method", "referrer", "integrity", "proxy", "unix"])
  const booleans = new Set(["keepalive", "verbose", "decompress"])
  let metadata = 0
  if (init) {
    const prototype = Object.getPrototypeOf(init)
    if (prototype !== Object.prototype && prototype !== null) return "init-unknown" as const
    const keys = Reflect.ownKeys(init)
    if (keys.length > 32) return "init-unknown" as const
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(init, key)
      if (!descriptor || !("value" in descriptor)) return "init-unknown" as const
      const value: unknown = descriptor.value
      if (value === undefined) continue
      if (typeof key !== "string") return "init-unknown" as const
      // The job owns one cancellation control reference; its reachable graph is not a payload budget.
      if (key === "signal") {
        if (value !== null && !(value instanceof AbortSignal)) return "init-unknown" as const
        continue
      }
      const reserved = key === "body" || key === "headers"
      const valid =
        reserved ||
        (strings.has(key) && typeof value === "string") ||
        (booleans.has(key) && typeof value === "boolean") ||
        (Object.hasOwn(enums, key) && typeof value === "string" && enums[key].includes(value)) ||
        (key === "window" && value === null) ||
        (key === "timeout" && (value === false || (typeof value === "number" && Number.isFinite(value) && value > 0)))
      if (!valid) return "init-unknown" as const
      metadata += Buffer.byteLength(key) + (!reserved && typeof value === "string" ? Buffer.byteLength(value) : 0)
      if (metadata > capacity) return "queue-full" as const
      Object.assign(opts, { [key]: value })
    }
  }
  const length = size(input, opts)
  if (length === undefined) return "body-unknown" as const
  // Request carries implicit transport settings and a potentially opaque retained body.
  if (input instanceof Request) return "init-unknown" as const
  const url = input.toString()
  let bytes = 256 + Buffer.byteLength(url) + length + metadata
  if (bytes > capacity) return "queue-full" as const
  const source = opts.headers
  const headers = new Headers()
  const entries = source instanceof Headers || Array.isArray(source) ? source : undefined
  let fragments = 0
  const append = (key: unknown, value: unknown) => {
    if (typeof key !== "string" || typeof value !== "string" || ++fragments > 256) return "init-unknown" as const
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4
    if (bytes > capacity) return "queue-full" as const
    try {
      headers.append(key, value)
    } catch {
      return "init-unknown" as const
    }
    return undefined
  }
  if (entries) {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) return "init-unknown" as const
      const error = append(entry[0], entry[1])
      if (error) return error
    }
  } else if (source) {
    // Effect's native HTTP client supplies a branded header map. Only own string data is retained.
    if (typeof source !== "object" || Symbol.iterator in source) return "init-unknown" as const
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      if (!descriptor || !("value" in descriptor)) return "init-unknown" as const
      const error = append(key, descriptor.value)
      if (error) return error
    }
  }
  const body =
    opts.body instanceof ArrayBuffer
      ? opts.body.slice(0)
      : ArrayBuffer.isView(opts.body)
        ? new Uint8Array(new Uint8Array(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength))
        : opts.body instanceof URLSearchParams
          ? opts.body.toString()
          : opts.body
  if (source !== undefined) opts.headers = headers
  if (body !== undefined) opts.body = body
  return { input: url, init: opts, bytes }
}

/** One client transport slot lasts through body settlement, never just response headers. */
export function createLocalScheduler(input: Partial<Limits> = {}) {
  const limits: Limits = { active: 1, count: 8, bytes: 8 * 1024 * 1024, age: 60_000, ...input }
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid local scheduler ${key}`)
  const queue: Job[] = []
  let active = 0
  let bytes = 0

  const detach = (job: Job) => {
    clearTimeout(job.timer)
    if (job.abort) job.signal?.removeEventListener("abort", job.abort)
  }
  const finish = (job: Job) => {
    if (job.phase === "closed") return
    detach(job)
    job.phase = "closed"
    active--
    job.reader?.releaseLock()
    next()
  }
  const remove = (job: Job, error: unknown) => {
    if (job.phase !== "queued") return
    const index = queue.indexOf(job)
    if (index < 0) return
    queue.splice(index, 1)
    bytes -= job.bytes
    detach(job)
    job.phase = "closed"
    job.reject(error)
  }
  const cancel = (job: Job, error: unknown): Promise<void> => {
    if (job.phase === "queued") {
      remove(job, error)
      return Promise.resolve()
    }
    if (job.phase === "closed") return Promise.resolve()
    if (job.cancellation) return job.cancellation
    if (!job.reader) {
      job.controller.abort(error)
      return Promise.resolve()
    }
    job.phase = "cancelling"
    // Cancel the owned reader before aborting fetch; abort can error its stream with the requested reason.
    job.cancellation = job.reader.cancel(error).finally(() => finish(job))
    job.controller.abort(error)
    return job.cancellation
  }
  const dispatch = async (job: Job) => {
    clearTimeout(job.timer)
    job.phase = "fetching"
    active++
    try {
      const response = await job.fetcher(job.input, { ...job.init, signal: job.controller.signal })
      if (job.controller.signal.aborted) {
        await response.body?.cancel(job.controller.signal.reason)
        throw job.controller.signal.reason
      }
      const method = job.init?.method ?? (job.input instanceof Request ? job.input.method : "GET")
      if (!response.body || method.toUpperCase() === "HEAD" || [204, 205, 304].includes(response.status)) {
        await response.body?.cancel()
        finish(job)
        job.resolve(response)
        return
      }
      job.reader = response.body.getReader()
      job.phase = "streaming"
      const reader = job.reader
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            job.output = controller
          },
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (job.phase === "closed" || job.phase === "cancelling") return
              if (chunk.done) {
                controller.close()
                finish(job)
                return
              }
              controller.enqueue(chunk.value)
            } catch (error) {
              controller.error(error)
              if (job.phase !== "cancelling") finish(job)
            }
          },
          async cancel(error) {
            await cancel(job, error)
          },
        },
        { highWaterMark: 0 },
      )
      job.resolve(
        new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
      )
    } catch (error) {
      finish(job)
      job.reject(error)
    }
  }
  function next() {
    while (active < limits.active && queue.length) {
      const job = queue.shift()!
      bytes -= job.bytes
      void dispatch(job)
    }
  }
  const fetch = (fetcher: Fetch, input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
    if (signal?.aborted) return Promise.reject(signal.reason)
    const waiting = active >= limits.active || queue.length > 0
    if (waiting && queue.length >= limits.count)
      return Promise.reject(
        new LocalInferenceError("queue-full", "The local model queue is full. Try again when a request finishes."),
      )
    const retained = waiting ? retain(input, init, limits.bytes - bytes) : undefined
    if (retained === "body-unknown")
      return Promise.reject(
        new LocalInferenceError(
          "body-unknown",
          "This local request cannot safely wait in the queue. Try again when the model is free.",
        ),
      )
    if (retained === "init-unknown")
      return Promise.reject(
        new LocalInferenceError(
          "init-unknown",
          "This local request has transport options that cannot safely wait in the queue. Try again when the model is free.",
        ),
      )
    if (retained === "queue-full")
      return Promise.reject(
        new LocalInferenceError("queue-full", "The local model queue is full. Try again when a request finishes."),
      )
    return new Promise<Response>((resolve, reject) => {
      const job: Job = {
        input: retained?.input ?? input,
        init: retained?.init ?? init,
        fetcher,
        bytes: retained?.bytes ?? 0,
        phase: "queued",
        controller: new AbortController(),
        signal: signal ?? undefined,
        resolve,
        reject,
      }
      job.abort = () => {
        job.output?.error(signal?.reason)
        void cancel(job, signal?.reason).catch((error: unknown) => {
          job.reject(error)
        })
      }
      signal?.addEventListener("abort", job.abort, { once: true })
      queue.push(job)
      bytes += job.bytes
      job.timer = setTimeout(
        () =>
          remove(
            job,
            new LocalInferenceError("queue-timeout", "The local model is still busy. Try this request again."),
          ),
        limits.age,
      )
      next()
    })
  }
  return {
    fetch,
    snapshot() {
      return { active, queued: queue.length, bytes }
    },
  }
}

const shared = createLocalScheduler()

export function status() {
  return shared.snapshot()
}

/** Both native and AI SDK integrations reuse this one backend-local scheduler. */
export function localFetch(options: Readonly<Record<string, unknown>>, fetcher: Fetch = globalThis.fetch): Fetch {
  if (!localConfig(options).enabled) return fetcher
  const fetch: Fetch = (input, init) => shared.fetch(fetcher, input, init)
  return fetch
}
