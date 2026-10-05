import { Failure } from "./client"
import { isDeepStrictEqual } from "node:util"
import { canonical, decode, object, sha } from "./control/frames"
import { parse as operation } from "./operation"
import { parse } from "./settings"
import { sources } from "./setup-v2"
import { raw } from "./raw-response"
import { search } from "./search-results"
import type { BrainProposalCommand, BrainProposalResult } from "../shared/second-brain"

type Selection = Parameters<typeof operation>[1]
type Options = {
  id: string
  before: (request: unknown) => Promise<void>
  signal?: AbortSignal
  downstream?: Selection["downstream"]
}
type Record = {
  selected: Selection
  request: unknown
  sent: boolean
  prepared: boolean
  settled: boolean
  completed?: boolean
  retiring?: boolean
  retired?: boolean
  value?: ReturnType<typeof operation>
}
const authorized = new WeakMap<object, { client: ClientV2; setup: ReturnType<typeof parse>; request: unknown }>()

/** Only the original ClientV2 can authorize a token while consuming it. */
export function settlement(proof: object, setup: unknown, request: unknown, client: ClientV2) {
  const value = authorized.get(proof)
  return (
    value !== undefined &&
    value.client === client &&
    isDeepStrictEqual(value.setup, setup) &&
    isDeepStrictEqual(value.request, request)
  )
}
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
const hex = (value: unknown, size: number): value is string =>
  typeof value === "string" && value.length === size && new RegExp(`^[a-f0-9]{${size}}$`).test(value)
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
function json(bytes: Uint8Array) {
  return decode(bytes[bytes.length - 1] === 10 ? bytes : Buffer.concat([bytes, Buffer.from("\n")]), 262145)
}
function fingerprint(value: object) {
  const parsed = json(Buffer.from(JSON.stringify(value)))
  return sha(canonical(parsed.tree, parsed.text, true).replace(/\u007f/g, "\\u007f"))
}

/** Retained v2 selection; raw certificate bytes survive through original HTTP settlement. */
export class ClientV2 {
  #setup: Extract<ReturnType<typeof parse>, { version: 2 }>
  #token: string
  #used = new Set<string>()
  #records = new Map<string, Record>()
  #proofs = new WeakMap<object, { record: Record; completed: boolean }>()
  #selection?: { epoch: string; release: string }

  constructor(token: string, input: unknown) {
    const setup = parse(input)
    if (setup.version !== 2 || !token.trim() || /[\r\n]/.test(token))
      throw new Error("Explicit v2 Memory setup required")
    this.#setup = setup
    this.#token = token
  }

  async proposal(body: BrainProposalCommand, signal: AbortSignal): Promise<BrainProposalResult> {
    const selected = await this.health(signal)
    const response = await fetch(this.#setup.origin + "/v1/memory/proposals", {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        "X-Raya-Memory-Owner-Epoch": selected.epoch,
      },
      body: JSON.stringify(body),
    })
    const bytes = await raw(response, signal, 3000000)
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!response.ok)
      throw new Failure("proposal_conflict", "Review the original proposal; do not retry a write.", response.status)
    if (!value || typeof value !== "object" || !("capture_enabled" in value) || value.capture_enabled !== false)
      throw new Failure("invalid_response", "Proposal response is invalid.", response.status)
    return value as BrainProposalResult
  }

  private async request(path: string, signal: AbortSignal, method = "GET", selected?: Selection, body?: object) {
    signal.throwIfAborted()
    const response = await fetch(this.#setup.origin + path, {
      method,
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        ...(selected
          ? { "X-Raya-Memory-Owner-Epoch": selected.epoch, "X-Raya-Memory-Request-ID": selected.request }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {
      signal.throwIfAborted()
      throw new Failure("transport_error", "The original Memory request could not finish.", 0)
    })
    const bytes = await raw(response, signal)
    if (!response.ok)
      throw new Failure("service_error", "Inspect the original Memory request; do not resubmit.", response.status)
    return bytes
  }

  async health(signal?: AbortSignal) {
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    const value = object(json(await this.request("/health", scope)).value)
    const pins = object(value.source_sha256)
    if (
      Object.keys(pins).sort().join() !== [...sources].sort().join() ||
      sources.some((name) => pins[name] !== this.#setup.source_sha256[name]) ||
      value.operation_protocol !== this.#setup.protocol ||
      !hex(value.owner_epoch, 32) ||
      value.selected_release_sha256 !== fingerprint(this.#setup.source_sha256) ||
      typeof value.root !== "string" ||
      normalize(value.root) !== normalize(this.#setup.root) ||
      value.admission_required !== true ||
      value.capture_enabled !== false ||
      !integer(value.active, 2) ||
      ["namespace_valid", "ready", "draining", "retirement_pending", "retirement_unconfirmed"].some(
        (key) => typeof value[key] !== "boolean",
      )
    )
      throw new Failure("identity_mismatch", "Memory v2 identity differs from the selected setup.", 200)
    if (
      value.namespace_valid !== true ||
      value.retirement_unconfirmed ||
      value.retirement_pending ||
      value.draining ||
      !value.ready
    )
      throw new Failure("admission_closed", "Memory v2 admission or retirement is unconfirmed.", 200)
    return this.retain(value.owner_epoch, String(value.selected_release_sha256))
  }

  private retain(epoch: string, release: string) {
    const selected = Object.freeze({ epoch, release })
    if (this.#selection && (this.#selection.epoch !== selected.epoch || this.#selection.release !== selected.release))
      throw new Failure("identity_mismatch", "The original Memory owner changed; do not adopt its replacement.", 200)
    this.#selection ??= selected
    return this.#selection
  }

  private async send(kind: "sync" | "search", body: object, opts: Options, expected?: string) {
    const id = opts.id
    const before = opts.before
    const downstream = opts.downstream
      ? Object.freeze(opts.downstream.map((item) => Object.freeze({ ...item })))
      : undefined
    if (!hex(id, 32) || typeof before !== "function" || this.#used.has(id) || this.#used.size >= 256)
      throw new Error("A fresh bounded original Memory request is required")
    this.#used.add(id)
    const scope = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(185000)])
      : AbortSignal.timeout(185000)
    const health = await this.health(scope)
    const selected = Object.freeze({
      request: id,
      epoch: health.epoch,
      release: health.release,
      kind,
      digest: fingerprint(body),
      ...(downstream ? { downstream } : {}),
    })
    const request = Object.freeze({
      op: kind,
      id,
      root: this.#setup.root,
      owner_epoch: selected.epoch,
      selected_release_sha256: selected.release,
      bodySHA: selected.digest,
      source_sha256: this.#setup.source_sha256,
      ...(expected ? { expected } : {}),
    })
    const record: Record = { selected, request, sent: false, prepared: false, settled: false }
    this.#records.set(id, record)
    try {
      // Await the original durable write, even if the caller cancels while it is pending.
      await before(request)
      record.prepared = true
      scope.throwIfAborted()
      record.sent = true
      const bytes = await this.request(`/v1/memory/${kind}`, scope, "POST", selected, body)
      const value = operation(bytes, selected, "response")
      record.value = value
      return { ...value, signal: scope }
    } finally {
      record.settled = true
    }
  }

  /** Only this live client's joined original send can mint a never-attempted proof. */
  settlement(id: string) {
    const record = this.#records.get(id)
    if (!record?.settled || !record.prepared || record.sent || record.retiring || record.retired) return undefined
    const proof = Object.freeze({})
    this.#proofs.set(proof, { record, completed: false })
    return proof
  }

  /** Exact terminal GET from this original client; never a POST result or replacement owner. */
  completed(id: string) {
    const record = this.#records.get(id)
    if (!record?.settled || !record.prepared || !record.sent || !record.completed || record.retiring || record.retired)
      return undefined
    const proof = Object.freeze({})
    this.#proofs.set(proof, { record, completed: true })
    return proof
  }

  async settle(proof: object, id: string, body: () => Promise<void>) {
    const issued = this.#proofs.get(proof)
    const record = issued?.record
    if (
      !record ||
      record !== this.#records.get(id) ||
      !record.settled ||
      !record.prepared ||
      record.retiring ||
      record.retired ||
      (issued.completed ? !record.sent || !record.completed : record.sent)
    )
      throw new Error("Original Memory settlement required")
    this.#proofs.delete(proof)
    record.retiring = true
    authorized.set(proof, { client: this, setup: this.#setup, request: record.request })
    try {
      await body()
      record.retired = true
    } finally {
      record.retiring = false
      authorized.delete(proof)
    }
  }

  async search(query: string, opts: Options & { top?: number }) {
    const top = opts.top ?? 5
    if (
      !query.trim() ||
      query.length > 8000 ||
      !integer(top, 10) ||
      top === 0 ||
      Buffer.byteLength(JSON.stringify({ query, top })) > 16000
    )
      throw new Error("Supply a bounded Memory query and top of 1–10")
    const value = await this.send("search", { query, top }, opts)
    const results = search(value.result, normalize(this.#setup.root), top)
    value.signal.throwIfAborted()
    return Object.freeze({
      results,
      capture_enabled: false as const,
      kind: "source_candidates" as const,
    })
  }

  async sync(expected: string, opts: Options) {
    if (!hex(expected, 64)) throw new Error("Confirmed current policy required")
    const value = await this.send("sync", { force_rebuild: false, expected_policy_sha256: expected }, opts, expected)
    const result = object(value.result!)
    if (
      ["files", "chunks", "new_embeddings", "reused_embeddings"].some(
        (key) => !integer(result[key], key === "files" ? 128 : 10000),
      ) ||
      Number(result.new_embeddings) + Number(result.reused_embeddings) !== result.chunks
    )
      throw new Failure("invalid_response", "Memory sync result refused", 200)
    value.signal.throwIfAborted()
    return value.result
  }

  private original(id: string) {
    const record = this.#records.get(id)
    if (!record?.sent) throw new Error("Only an original attempted request can be inspected")
    return record
  }

  async observe(id: string, signal?: AbortSignal) {
    const record = this.original(id)
    record.completed = false
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    const bytes = await this.request(`/v1/memory/requests/${id}`, scope, "GET", record.selected)
    const status = object(json(bytes).value).status
    const value = operation(bytes, record.selected, status === "pending" ? "pending" : "terminal")
    record.value = value
    scope.throwIfAborted()
    record.completed = status === "terminal" && object(value.operation).operation_outcome === "completed"
    return value
  }

  async cancel(id: string, signal?: AbortSignal) {
    const record = this.original(id)
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    const value = object(json(await this.request(`/v1/memory/requests/${id}`, scope, "DELETE", record.selected)).value)
    if (
      Object.keys(value).sort().join() !== ["request", "owner_epoch", "retirement_acknowledged"].sort().join() ||
      value.request !== record.selected.request ||
      value.owner_epoch !== record.selected.epoch ||
      value.retirement_acknowledged !== false
    )
      throw new Failure("invalid_response", "Memory cancellation acknowledgement differs.", 200)
    scope.throwIfAborted()
    return Object.freeze({ retirement_acknowledged: false as const })
  }
}
