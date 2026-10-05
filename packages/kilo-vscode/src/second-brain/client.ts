// Extension-host capability client. Credentials must stay in SecretStorage, never a webview.
import { search } from "./search-results"
import { files, parse, type Setup } from "./settings"
import { createHash } from "node:crypto"
type Row = { [key: string]: unknown }
export class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "MemoryFailure"
  }
}

function record(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function integer(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= limit
}

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

function flags(value: Row) {
  return ["namespace_valid", "ready", "draining", "retirement_pending", "retirement_unconfirmed"].every(
    (name) => typeof value[name] === "boolean",
  )
}

async function consume(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  const result = await (async () => {
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !reader)
      throw new Failure("invalid_response", "Memory API returned an unsupported response.", response.status)
    const parts: Uint8Array[] = []
    let size = 0
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 262_144)
        throw new Failure("invalid_response", "Memory response exceeded its size limit.", response.status)
      parts.push(item.value)
    }
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
    } catch {
      throw new Failure("invalid_response", "Memory response was not valid UTF-8 JSON.", response.status)
    }
  })().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  const cleanup = await (async () => {
    if (!reader) return
    const failure = await reader.cancel().then(
      () => undefined,
      (error: unknown) => error,
    )
    const release = (() => {
      try {
        reader.releaseLock()
      } catch (error) {
        return error
      }
    })()
    if (failure !== undefined && release !== undefined)
      throw new AggregateError([failure, release], "Memory response cleanup failed")
    if (failure !== undefined) throw failure
    if (release !== undefined) throw release
  })().then(
    () => undefined,
    (error: unknown) => error,
  )
  if ("error" in result) {
    if (cleanup !== undefined) throw new AggregateError([result.error, cleanup], "Memory response cleanup failed")
    throw result.error
  }
  if (cleanup !== undefined) throw cleanup
  return result.value
}

export class BrainClient {
  #token: string
  #origin: string
  #root: string
  #selected: string
  #pins: Readonly<{ [file: string]: string }>

  constructor(token: string, input: Setup) {
    const setup = parse(input)
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error("Supply a local Memory credential")
    this.#token = token
    this.#origin = setup.origin
    this.#root = normalize(setup.root)
    this.#selected = setup.root
    this.#pins = setup.source_sha256
  }
  private async request(path: string, signal: AbortSignal, body?: object, id?: string): Promise<unknown> {
    signal.throwIfAborted()
    try {
      const response = await fetch(this.#origin + path, {
        method: body ? "POST" : "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          ...(id ? { "X-Raya-Request-ID": id } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      })
      const value = await consume(response, signal)
      if (!response.ok) {
        if (
          record(value) &&
          record(value.error) &&
          typeof value.error.code === "string" &&
          typeof value.error.message === "string"
        )
          throw new Failure(value.error.code, value.error.message, response.status)
        throw new Failure("service_error", "Memory API rejected the request.", response.status)
      }
      return value
    } catch (err) {
      if (err instanceof AggregateError) throw err
      signal.throwIfAborted()
      if (err instanceof Failure) throw err
      if (err instanceof SyntaxError) throw new Failure("invalid_response", "Memory response was not valid JSON.", 0)
      throw new Failure("transport_error", "The local memory request could not finish.", 0)
    }
  }

  async health(signal?: AbortSignal) {
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000)
    const value = await this.request("/health", scope)
    if (
      !record(value) ||
      !flags(value) ||
      value.admission_required !== true ||
      value.capture_enabled !== false ||
      typeof value.root !== "string" ||
      normalize(value.root) !== this.#root ||
      !integer(value.active, 2) ||
      !record(value.source_sha256)
    )
      throw new Failure(
        "identity_mismatch",
        "Memory service identity or capture policy does not match the configured host.",
        200,
      )
    const hashes = value.source_sha256
    if (Object.keys(hashes).length !== files.length || files.some((name) => hashes[name] !== this.#pins[name]))
      throw new Failure("identity_mismatch", "Memory service source pins do not match.", 200)
    if (value.namespace_valid !== true)
      throw new Failure("namespace_changed", "Memory directory identity requires trusted re-admission.", 200)
    if (value.retirement_unconfirmed)
      throw new Failure(
        "retirement_unconfirmed",
        "Memory cleanup is unconfirmed; trusted local inspection is required.",
        200,
      )
    if (value.retirement_pending)
      throw new Failure("retirement_pending", "Memory is waiting for the current retrieval request to retire.", 200)
    if (value.draining)
      throw new Failure("service_draining", "Memory admission is temporarily closed by its lifecycle owner.", 200)
    if (!value.ready) throw new Failure("service_unavailable", "Memory is not ready for new work.", 200)
    return Object.freeze({
      root: value.root,
      active: value.active,
      capture_enabled: false as const,
      admission_required: true as const,
      source_sha256: Object.freeze({ ...hashes }),
    })
  }

  async search(query: string, opts: { top?: number; signal?: AbortSignal; timeout?: number } = {}) {
    const top = opts.top ?? 5
    const timeout = opts.timeout ?? 185_000
    if (
      !query.trim() ||
      query.length > 8000 ||
      !integer(top, 10) ||
      top === 0 ||
      !integer(timeout, 185_000) ||
      timeout === 0
    )
      throw new Error("Supply a bounded memory query, top of 1–10 and timeout of 1–185000 ms.")
    const scope = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout)
    await this.health(scope)
    const value = await this.request("/v1/memory/search", scope, { query, top })
    const results = search(value, this.#root, top)
    scope.throwIfAborted()
    return Object.freeze({
      results: Object.freeze(results),
      capture_enabled: false as const,
      kind: "source_candidates" as const,
    })
  }

  /** Explicit native confirmation supplies the exact current policy; never replay a failed mutation. */
  async sync(expected: string, signal?: AbortSignal, before?: (request: unknown) => Promise<void>) {
    if (!hash(expected)) throw new Error("Confirmed current policy required")
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(185_000)]) : AbortSignal.timeout(185_000)
    await this.health(scope)
    const body = { force_rebuild: false, expected_policy_sha256: expected }
    const id = crypto.randomUUID()
    if (before)
      await before(
        Object.freeze({
          op: "sync",
          id,
          expected,
          bodySHA: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
          root: this.#selected,
          source_sha256: Object.freeze({ ...this.#pins }),
        }),
      )
    scope.throwIfAborted()
    const value = await this.request("/v1/memory/sync", scope, body, id)
    const keys = ["files", "chunks", "new_embeddings", "reused_embeddings"]
    if (
      !record(value) ||
      Object.keys(value).sort().join() !== keys.sort().join() ||
      keys.some((key) => !integer(value[key], key === "files" ? 128 : 10000)) ||
      Number(value.new_embeddings) + Number(value.reused_embeddings) !== value.chunks
    )
      throw new Failure("invalid_response", "Memory sync result refused", 200)
    return Object.freeze({ ...value })
  }
}
