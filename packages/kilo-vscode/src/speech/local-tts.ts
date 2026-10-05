import { createHash, randomUUID } from "node:crypto"
import type { TtsInput, TtsResult } from "./minimax-tts"
import { diagnostics, type PlaybackDiagnostic } from "./diagnostics"

type Choice = { model: string; voice: string; fallback: { from: string; reason: string } | null }
type Sink = {
  cleanup?: (confirmed: boolean) => void
  voice?: (choice: Choice) => void
  chunk: (data: string, mime: string) => void
  done: (result: TtsResult & Choice) => void
  error: (message: string) => void
}
type Chunk = { index: number; url: string; seconds: number; mime: string; bytes: number; sha256: string }
type Job = Choice & { id: string; status: string; chunks: Chunk[] }
type State = { id: string; ctrl: AbortController; done: Promise<void>; cleanup: boolean }

/** Extension-host only: authenticated local jobs never expose credentials to the renderer. */
export class LocalTts {
  private readonly jobs = new Map<string, State>()
  private readonly pending = new Set<State>()
  private closed = false
  private incomplete = false

  constructor(
    private readonly opts: { timeout?: number; poll?: number; diagnostic?: (row: PlaybackDiagnostic) => void } = {},
  ) {}

  speak(input: TtsInput & { allowFallback?: boolean }, sink: Sink): Promise<void> {
    if (this.closed) {
      sink.error("Local speech is closed.")
      return Promise.resolve()
    }
    this.jobs.get(input.id)?.ctrl.abort()
    const ctrl = new AbortController()
    const state = { id: input.id, ctrl, done: Promise.resolve(), cleanup: true }
    this.jobs.set(input.id, state)
    this.pending.add(state)
    state.done = this.run(input, sink, state).finally(() => {
      if (this.jobs.get(input.id) === state) this.jobs.delete(input.id)
      this.pending.delete(state)
    })
    return state.done
  }

  async cancel(id?: string): Promise<void> {
    const jobs = [...this.pending].filter((job) => !id || job.id === id)
    for (const job of jobs) job.ctrl.abort()
    await Promise.all(jobs.map((job) => job.done))
    if (this.incomplete || jobs.some((job) => !job.cleanup)) throw new Error("Local speech cleanup is unconfirmed.")
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.cancel()
  }

  private async run(input: TtsInput & { allowFallback?: boolean }, sink: Sink, state: State) {
    const id = randomUUID().replaceAll("-", "")
    const trace = diagnostics(input.id, this.opts.diagnostic)
    trace("start", { job: id })
    const timeout = this.opts.timeout ?? 180_000
    const poll = this.opts.poll ?? 200
    const errors: unknown[] = []
    let cleanup = false
    const owner = { origin: "", attempted: false }
    const timer = setTimeout(() => state.ctrl.abort(new Error("Local speech deadline exceeded.")), timeout)
    const live = () => {
      state.ctrl.signal.throwIfAborted()
      if (this.closed || this.jobs.get(input.id) !== state) throw new Error("Local speech generation expired.")
    }
    let result: (TtsResult & Choice) | undefined
    try {
      owner.origin = validate(input, timeout, poll)
      result = await stream(input, sink, state.ctrl.signal, owner, id, poll, live, trace)
    } catch (err) {
      trace("error", { job: id, status: state.ctrl.signal.aborted ? "cancelled" : "failed" })
      errors.push(err)
    } finally {
      clearTimeout(timer)
      if (owner.attempted) {
        state.cleanup = false
        try {
          await remove(owner.origin, input.key, id)
          state.cleanup = true
        } catch (err) {
          cleanup = true
          errors.push(err)
        }
        if (!state.cleanup) this.incomplete = true
        sink.cleanup?.(state.cleanup)
        trace("cleanup", { job: id, confirmed: state.cleanup })
      }
    }
    if (this.jobs.get(input.id) !== state || this.closed) {
      if (cleanup) console.error("[Raya] Retired local speech job cleanup is unconfirmed.")
      return
    }
    const cancelled = state.ctrl.signal.aborted && state.ctrl.signal.reason?.name === "AbortError"
    if (errors.length) {
      if (!cancelled || cleanup)
        sink.error(errors.length > 1 ? "Local speech failed and cleanup is unconfirmed." : safe(errors[0]))
      return
    }
    if (!state.ctrl.signal.aborted && result) sink.done(result)
  }
}

function validate(input: TtsInput, timeout: number, poll: number) {
  deadline(timeout, poll)
  const url = new URL(input.endpoint)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Local speech requires a numeric loopback HTTP origin.")
  if (
    !input.key ||
    !input.id ||
    !input.text.trim() ||
    input.text.trim().length > 4000 ||
    !["chatterbox-nano", "kokoro"].includes(input.model)
  )
    throw new Error("Invalid local speech input.")
  if (input.model === "kokoro" && input.voice !== "am_onyx") throw new Error("Invalid Kokoro voice.")
  return url.origin
}

function deadline(timeout: number, poll: number) {
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 180_000 ||
    !Number.isInteger(poll) ||
    poll < 1 ||
    poll > 1000
  )
    throw new Error("Invalid local speech deadline.")
}

async function request(
  origin: string,
  key: string,
  path: string,
  signal: AbortSignal,
  opts: RequestInit = {},
  trace?: ReturnType<typeof diagnostics>,
) {
  const response = await fetch(origin + path, {
    ...opts,
    signal,
    redirect: "error",
    headers: { ...opts.headers, Authorization: "Bearer " + key },
  })
  if (!response.ok) {
    trace?.("error", { http: response.status })
    await response.body?.cancel()
    throw new Error("Local speech HTTP " + response.status + ".")
  }
  return response
}

async function json(response: Response): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bounded(response, 262_144)))
}

async function remove(origin: string, key: string, id: string) {
  const response = await fetch(origin + "/v1/jobs/" + id, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + key },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error("Local speech cleanup failed.")
}

function selection(input: TtsInput & { allowFallback?: boolean }, job: Job, previous?: Choice): Choice {
  const fallback =
    input.model === "chatterbox-nano" &&
    input.allowFallback === true &&
    job.model === "kokoro" &&
    job.voice === "am_onyx" &&
    job.fallback?.from === "chatterbox-nano" &&
    job.fallback.reason === "primary_synthesis_failed"
  if (!fallback && (job.model !== input.model || job.voice !== input.voice || job.fallback !== null))
    throw new Error("Local speech selection differs.")
  const current = { model: job.model, voice: job.voice, fallback: job.fallback }
  if (previous && JSON.stringify(previous) !== JSON.stringify(current))
    throw new Error("Local speech changed voice after publication.")
  return current
}

async function audio(chunk: Chunk, get: (path: string, signal: AbortSignal) => Promise<Response>, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await download(chunk, (path) => get(path, AbortSignal.any([signal, AbortSignal.timeout(5000)])))
    } catch (err) {
      signal.throwIfAborted()
      if (attempt === 2 || !transient(err)) throw err
      await pause(200, signal)
    }
  }
  throw new Error("Local speech download failed.")
}

function transient(err: unknown) {
  return err instanceof TypeError || (err instanceof DOMException && ["TimeoutError", "AbortError"].includes(err.name))
}

async function download(chunk: Chunk, get: (path: string) => Promise<Response>) {
  const response = await get(chunk.url)
  if (response.headers.get("content-type")?.split(";")[0] !== "audio/wav") {
    await response.body?.cancel()
    throw new Error("Invalid local speech audio MIME.")
  }
  const bytes = await bounded(response, 16_777_216)
  if (bytes.length !== chunk.bytes || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256)
    throw new Error("Local speech audio integrity failed.")
  const result = pcm(bytes)
  if (Math.abs(result.bytes.length / (result.rate * 2) - chunk.seconds) > 0.05)
    throw new Error("Local speech duration differs.")
  return result
}

async function stream(
  input: TtsInput & { allowFallback?: boolean },
  sink: Sink,
  signal: AbortSignal,
  owner: { origin: string; attempted: boolean },
  id: string,
  poll: number,
  live: () => void,
  trace: ReturnType<typeof diagnostics>,
) {
  const start = Date.now()
  const stats = { firstAudioMs: 0, chunks: 0, bytes: 0 }
  const get = (path: string) => request(owner.origin, input.key, path, signal, {}, trace)
  const health = object(await json(await get("/health")))
  trace("health", { job: id, http: 200 })
  if (!Number.isInteger(health.version) || Number(health.version) < 2 || health.ready !== true)
    throw new Error("Local speech does not support owned jobs.")
  live()
  owner.attempted = true
  let job = parse(
    await json(
      await request(
        owner.origin,
        input.key,
        "/v1/jobs",
        signal,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Raya-Job-ID": id },
          body: JSON.stringify({
            kind: "speech",
            model: input.model,
            input: input.text,
            allow_fallback: input.allowFallback === true,
          }),
        },
        trace,
      ),
    ),
    id,
  )
  const seen: Chunk[] = []
  let choice: Choice | undefined
  let status = ""
  while (true) {
    live()
    status = publication(trace, id, job, status)
    if (job.status === "failed" || job.status === "cancelled") throw new Error("Local speech job " + job.status + ".")
    const current = selection(input, job, choice)
    if (job.chunks.length < seen.length) throw new Error("Local speech removed published chunks.")
    for (const chunk of job.chunks) {
      if (chunk.index < seen.length) {
        if (JSON.stringify(chunk) !== JSON.stringify(seen[chunk.index]))
          throw new Error("Local speech changed a published chunk.")
        continue
      }
      live()
      if (chunk.index !== seen.length || chunk.url !== "/v1/jobs/" + id + "/audio/" + chunk.index)
        throw new Error("Invalid local speech chunk order.")
      const data = await audio(chunk, (path, scope) => request(owner.origin, input.key, path, scope, {}, trace), signal)
      live()
      if (stats.bytes + data.bytes.length > 67_108_864) throw new Error("Local speech output exceeds its bound.")
      if (!choice) sink.voice?.(current)
      live()
      choice = current
      seen.push(chunk)
      stats.firstAudioMs ||= Date.now() - start
      stats.chunks++
      stats.bytes += data.bytes.length
      trace("chunk", {
        job: id,
        index: chunk.index,
        bytes: data.bytes.length,
        rate: data.rate,
        mime: "audio/pcm",
        ...amplitude(data.bytes),
      })
      sink.chunk(data.bytes.toString("base64"), "audio/pcm;rate=" + data.rate)
    }
    if (job.status === "completed") {
      if (!choice || !stats.chunks) throw new Error("Local speech completed without audio.")
      return { ...stats, ...choice }
    }
    await pause(poll, signal)
    job = parse(await json(await get("/v1/jobs/" + id)), id)
  }
}

function publication(trace: ReturnType<typeof diagnostics>, id: string, job: Job, previous: string) {
  if (job.status !== previous)
    trace("job", { job: id, status: job.status as PlaybackDiagnostic["status"], chunks: job.chunks.length, http: 200 })
  return job.status
}

function amplitude(bytes: Buffer) {
  const result = { nonzero: 0, peak: 0 }
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset)
    if (sample) result.nonzero++
    result.peak = Math.max(result.peak, Math.abs(sample))
  }
  return result
}

function safe(err: unknown) {
  return err instanceof Error && err.message.startsWith("Local speech")
    ? err.message
    : "Local speech request or audio validation failed."
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Local speech returned invalid JSON.")
  return value as Record<string, unknown>
}

function parse(value: unknown, id: string): Job {
  const row = object(value)
  if (
    row.id !== id ||
    !["queued", "running", "completed", "failed", "cancelled"].includes(String(row.status)) ||
    typeof row.model !== "string" ||
    typeof row.voice !== "string" ||
    !Array.isArray(row.chunks) ||
    row.chunks.length > 64
  )
    throw new Error("Local speech returned an invalid job.")
  const fallback = row.fallback === null ? null : object(row.fallback)
  if (fallback && (typeof fallback.from !== "string" || typeof fallback.reason !== "string"))
    throw new Error("Local speech returned invalid fallback metadata.")
  const chunks = row.chunks.map((value, index) => {
    const chunk = object(value)
    if (
      chunk.index !== index ||
      typeof chunk.url !== "string" ||
      chunk.mime !== "audio/wav" ||
      typeof chunk.seconds !== "number" ||
      !Number.isFinite(chunk.seconds) ||
      chunk.seconds <= 0 ||
      typeof chunk.bytes !== "number" ||
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes < 44 ||
      chunk.bytes > 16_777_216 ||
      typeof chunk.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(chunk.sha256)
    )
      throw new Error("Local speech returned an invalid chunk.")
    return {
      index,
      url: chunk.url,
      seconds: chunk.seconds,
      mime: "audio/wav",
      bytes: chunk.bytes,
      sha256: chunk.sha256,
    }
  })
  return {
    id,
    status: String(row.status),
    model: row.model,
    voice: row.voice,
    fallback: fallback ? { from: String(fallback.from), reason: String(fallback.reason) } : null,
    chunks,
  }
}

async function bounded(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw new Error("Local speech returned an empty response.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const row = await reader.read()
      if (row.done) break
      bytes += row.value.length
      if (bytes > max) throw new Error("Local speech response exceeds its bound.")
      chunks.push(row.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

function pcm(bytes: Buffer) {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Local speech returned invalid WAV.")
  let offset = 12
  let rate = 0
  let data: Buffer | undefined
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Local speech returned truncated WAV.")
    const name = bytes.toString("ascii", offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const begin = offset + 8
    const end = begin + size
    if (end + (size % 2) > bytes.length) throw new Error("Local speech returned truncated WAV.")
    if (name === "fmt ") {
      if (rate) throw new Error("Local speech returned duplicate PCM format.")
      rate = format(bytes.subarray(begin, end))
    }
    if (name === "data") {
      if (data || !rate || !size || size % 2) throw new Error("Local speech returned invalid PCM data.")
      data = bytes.subarray(begin, end)
    }
    offset = end + (size % 2)
  }
  if (!rate || !data) throw new Error("Local speech returned incomplete WAV.")
  return { rate, bytes: data }
}

function format(bytes: Buffer) {
  if (
    bytes.length !== 16 ||
    bytes.readUInt16LE(0) !== 1 ||
    bytes.readUInt16LE(2) !== 1 ||
    bytes.readUInt16LE(14) !== 16
  )
    throw new Error("Local speech requires PCM16 mono WAV.")
  const rate = bytes.readUInt32LE(4)
  if (rate < 8000 || rate > 96000 || bytes.readUInt16LE(12) !== 2 || bytes.readUInt32LE(8) !== rate * 2)
    throw new Error("Local speech returned invalid PCM format.")
  return rate
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
