// raya_change - Milestone F testable CLI-to-Playwright browser bridge
import { DialogPendingError } from "./browser-dialog"
import { createHash } from "node:crypto"
import type {
  BrowserFailure,
  BrowserRequest,
  BrowserResult as HostBrowserResult,
  EventKilocodeBrowserCancelled,
  EventKilocodeBrowserRequested,
  KiloClient,
} from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import type { ConnectionState } from "../cli-backend/connection-service"
import { BrowserOutcomeError, type BrowserAction, type BrowserResult } from "./browser-session"
import type { UploadTransport } from "./browser-upload"

export interface BrowserConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

export interface BrowserHost {
  show(directory?: string): Promise<void>
  execute(action: BrowserAction): Promise<BrowserResult>
  cancel?(): void
  uncertain?(directory: string, reason: string): Promise<void> | void
}

function action(request: BrowserRequest): BrowserAction {
  if (request.operation === "scroll") {
    const x = Number(request.deltaX)
    const y = Number(request.deltaY)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Browser scroll deltas must be finite numbers")
    return {
      operation: "scroll",
      tabID: request.tabID,
      frameID: request.frameID,
      deltaX: x,
      deltaY: y,
      selector: request.selector,
    }
  }
  // raya_change start - Milestone G validates generated special-number unions at the host boundary
  if (request.operation === "smoke")
    return {
      operation: "smoke",
      tabID: request.tabID,
      name: request.name,
      mode: request.mode,
      steps: request.steps.map((step) => ({
        ...step,
        assertions: step.assertions.map((assertion) => {
          if (assertion.kind === "visible") return assertion
          if (assertion.kind === "network") {
            const status = assertion.status === undefined ? undefined : Number(assertion.status)
            if (status !== undefined && !Number.isFinite(status))
              throw new Error(`Smoke step ${step.id} has an invalid network status`)
            return { ...assertion, status }
          }
          const max = Number(assertion.max)
          if (!Number.isFinite(max) || max < 0) throw new Error(`Smoke step ${step.id} has an invalid console maximum`)
          return { ...assertion, max }
        }),
      })),
    }
  // raya_change end
  return request
}

type Receipt = { fingerprint: string; result?: HostBrowserResult; failure?: BrowserFailure; delivered?: boolean }
type Active = {
  controller: AbortController
  request: BrowserRequest
  directory: string
  startedAt: number
  receipt: Receipt
}
type Admission = { receipt: Receipt } | { settle: Promise<void> }
export interface BrowserReceiptStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

const journal = "raya.computerUse.browser.failureReceipts.v1"
const codes = new Set([
  "dialog_pending",
  "cancelled",
  "closed",
  "disconnected",
  "evaluation_failed",
  "invalid_request",
  "navigation_failed",
  "not_found",
  "timeout",
  "unsupported",
])
const effects = new Set(["observe", "navigate", "interact", "manage", "transfer", "authenticate", "test"])

function scope(directory: string) {
  return createHash("sha256").update(directory).digest("hex")
}

function fingerprint(request: BrowserRequest, directory: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([directory, request], (_key, value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      }),
    )
    .digest("hex")
}

function effect(request: BrowserRequest) {
  if (["snapshot", "screenshot", "frames"].includes(request.operation)) return "observe" as const
  if (request.operation === "navigate") return "navigate" as const
  if (["click", "type", "select", "scroll", "evaluate"].includes(request.operation)) return "interact" as const
  if (request.operation === "upload" || request.operation === "download") return "transfer" as const
  if (request.operation === "auth" || request.operation === "auth_capture" || request.operation === "profile")
    return "authenticate" as const
  if (request.operation === "smoke") return "test" as const
  return "manage" as const
}

function target(request: BrowserRequest, result?: BrowserResult) {
  const tabID = result?.tabID ?? ("tabID" in request ? request.tabID : undefined)
  if (!tabID) return undefined
  const frameID = result?.frameID ?? ("frameID" in request ? request.frameID : undefined)
  const location =
    result && "url" in result
      ? (result.frameURL ?? result.url)
      : request.operation === "navigate"
        ? request.url
        : undefined
  return {
    surface: "browser" as const,
    windowID: tabID,
    ...(frameID ? { documentID: frameID } : {}),
    ...(location ? { location } : {}),
  }
}

function evidence(
  request: BrowserRequest,
  startedAt: number,
  outcome: "confirmed" | "unknown",
  result?: BrowserResult,
) {
  const observationID = "observationID" in request ? request.observationID : undefined
  return {
    version: 1 as const,
    requestID: request.id,
    startedAt,
    finishedAt: Date.now(),
    effect: effect(request),
    outcome,
    target: target(request, result),
    ...(observationID ? { observationID } : {}),
  }
}

export class BrowserBridge {
  private readonly active = new Map<string, Active>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly blocked = new Set<string>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private writes = Promise.resolve()
  private revision = 0
  private connected = false
  private disposed = false

  constructor(
    private readonly connection: BrowserConnection,
    private readonly host: BrowserHost,
    private readonly store?: BrowserReceiptStore,
  ) {
    this.restore()
    this.offEvent = connection.onEvent((event, directory) => this.event(event, directory))
    this.offState = connection.onStateChange((state) => this.state(state))
  }

  private event(event: SSEPayload, directory?: string): void {
    const value = event as unknown as EventKilocodeBrowserRequested | EventKilocodeBrowserCancelled
    if (value.type === "kilocode.browser.cancelled") {
      const active = this.active.get(value.properties.requestID)
      if (active) this.interrupt(active, "The browser request was cancelled after it may have been dispatched.")
      this.active.delete(value.properties.requestID)
      if (active) this.host.cancel?.()
      return
    }
    if (value.type !== "kilocode.browser.requested" || !directory) return
    void this.run(value.properties, directory)
  }

  private state(state: ConnectionState): void {
    if (state === "connected") {
      this.connected = true
      const revision = ++this.revision
      void this.recover(revision).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        console.error("[Raya] Browser request recovery read failed; no work replayed:", detail.slice(0, 1000))
      })
      return
    }
    if (!this.connected || (state !== "disconnected" && state !== "error")) return
    this.connected = false
    this.revision += 1
    for (const active of this.active.values())
      this.interrupt(active, "The browser backend disconnected after this request may have been dispatched.")
    this.active.clear()
    this.host.cancel?.()
  }

  private async recover(revision: number): Promise<void> {
    for (const directory of this.connection.getKnownDirectories()) {
      if (this.disposed || revision !== this.revision) return
      const response = await this.connection.getClient().kilocode.browser.list({ directory })
      if (response.error) {
        console.error("[Raya] BrowserBridge: request recovery failed:", response.error)
        continue
      }
      for (const request of response.data ?? []) {
        void this.run(request, directory, true)
      }
    }
  }

  private show(request: BrowserRequest, directory: string) {
    if (request.operation === "profile" || request.operation === "auth") return Promise.resolve()
    if (request.operation === "upload" && request.action !== "start") return Promise.resolve()
    if (request.operation !== "download" || request.action === "start") return this.host.show(directory)
    return Promise.resolve()
  }

  private uploader(request: BrowserRequest, directory: string): UploadTransport | undefined {
    if (request.operation !== "upload" || request.action !== "start") return
    const owner = { directory, sessionID: request.sessionID, uploadID: request.uploadID }
    return {
      chunk: async (file, offset, signal) => {
        const response = await this.connection
          .getClient()
          .kilocode.browser.uploadChunk({ ...owner, fileID: file.id, offset }, { signal })
        if (response.error || !response.data) throw new Error("Authorized upload chunk could not be read")
        return response.data
      },
      release: async (file) => {
        const response = await this.connection
          .getClient()
          .kilocode.browser.uploadRelease({ ...owner, fileID: file.id }, { signal: AbortSignal.timeout(5000) })
        if (response.error) throw new Error("Source upload bytes could not be released")
      },
    }
  }

  private admit(request: BrowserRequest, directory: string, hash: string, recovered: boolean): Admission | undefined {
    const prior = this.receipts.get(request.id)
    if (prior && prior.fingerprint !== hash) {
      return {
        settle: this.deliver(request.id, directory, {
          fingerprint: hash,
          failure: {
            code: "invalid_request",
            message: "Browser request ID was reused with different content; no new action was dispatched.",
          },
        }),
      }
    }
    if (this.active.has(request.id)) return
    if (prior) {
      return {
        settle: (async () => {
          if (persistable(prior.failure)) await this.pause(directory, prior.failure.message)
          await this.deliver(request.id, directory, prior)
        })(),
      }
    }
    if (effect(request) !== "observe" && this.blocked.has(scope(directory))) {
      const message =
        "Browser actions are paused because an earlier action has an unknown outcome. Inspect the destination, then explicitly resume browser control before trying another action."
      return {
        settle: (async () => {
          await this.pause(directory, message)
          await this.deliver(request.id, directory, {
            fingerprint: hash,
            failure: { code: "invalid_request", message },
          })
        })(),
      }
    }
    this.compact()
    // Never evict an unresolved ID and later mistake it for new work. Capacity fails before dispatch.
    if (this.receipts.size >= 1024) {
      return {
        settle: this.deliver(request.id, directory, {
          fingerprint: hash,
          failure: {
            code: "invalid_request",
            message:
              "Browser receipt capacity (1,024 requests) reached; this request was not dispatched. Reconnecting does not clear receipts. Review unresolved outcomes before intentionally reloading the extension. Reloading discards local receipts and cannot establish old outcomes.",
          },
        }),
      }
    }
    const receipt: Receipt = {
      fingerprint: hash,
      failure: {
        code: "cancelled",
        message:
          "This browser request was already admitted but its outcome is unconfirmed. It will not be dispatched again. Inspect the destination before repeating the action with a new request.",
      },
    }
    this.receipts.set(request.id, receipt)
    if (!recovered) return { receipt }
    const startedAt = Date.now()
    receipt.failure = {
      code: "invalid_request",
      message:
        "Recovered browser request has no local execution receipt. Its prior outcome is unknown, so it was not replayed. Inspect the destination before issuing a fresh request.",
      ...(effect(request) !== "observe" ? { receipt: evidence(request, startedAt, "unknown") } : {}),
    }
    return {
      settle: (async () => {
        if (persistable(receipt.failure)) await this.pause(directory, receipt.failure.message)
        await this.deliver(request.id, directory, receipt)
      })(),
    }
  }

  private failed(request: BrowserRequest, startedAt: number, completed: boolean, error: unknown): BrowserFailure {
    const detail = error instanceof Error ? error.message : String(error)
    const unknown = error instanceof BrowserOutcomeError || error instanceof DialogPendingError || completed
    const message = completed
      ? `Browser action completed but its result could not be retained. It will not be replayed. Inspect the destination. ${detail}`
      : detail
    const code =
      error instanceof DialogPendingError
        ? "dialog_pending"
        : request.operation === "navigate"
          ? "navigation_failed"
          : request.operation === "evaluate"
            ? "evaluation_failed"
            : "invalid_request"
    return {
      code,
      message: message.slice(0, 10_000),
      ...(unknown ? { receipt: evidence(request, startedAt, "unknown") } : {}),
    }
  }

  private async run(request: BrowserRequest, directory: string, recovered = false): Promise<void> {
    if (this.disposed) return
    const hash = fingerprint(request, directory)
    const admission = this.admit(request, directory, hash, recovered)
    if (!admission) return
    if ("settle" in admission) {
      await admission.settle
      return
    }
    const receipt = admission.receipt
    const controller = new AbortController()
    const startedAt = Date.now()
    this.active.set(request.id, { controller, request, directory, startedAt, receipt })
    const state = { completed: false }
    try {
      await this.show(request, directory)
      if (controller.signal.aborted) return
      const value = await this.host.execute({
        ...action(request),
        origin: { requestID: request.id, sessionID: request.sessionID, directory },
        uploader: this.uploader(request, directory),
      })
      const result = Object.assign(value, {
        receipt: evidence(request, startedAt, "confirmed", value),
      }) as HostBrowserResult
      state.completed = true
      if (controller.signal.aborted) return
      if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 64_000) {
        receipt.result = result
        receipt.failure = undefined
      } else {
        receipt.failure = {
          code: "invalid_request",
          message:
            "This browser request completed, but its result exceeds the retained receipt limit. It will not execute again. Inspect the destination for the result.",
        }
      }
      await this.deliver(request.id, directory, { fingerprint: hash, result }, receipt)
    } catch (error) {
      if (controller.signal.aborted) return
      receipt.failure = this.failed(request, startedAt, state.completed, error)
      if (receipt.failure.receipt) await this.pause(directory, receipt.failure.message)
      await this.deliver(request.id, directory, receipt)
    } finally {
      if (this.active.get(request.id)?.controller === controller) this.active.delete(request.id)
    }
  }

  private async deliver(requestID: string, directory: string, receipt: Receipt, owner = receipt): Promise<void> {
    try {
      const client = this.connection.getClient().kilocode.browser
      const response = receipt.result
        ? await client.reply({ requestID, directory, result: receipt.result })
        : await client.reject({ requestID, directory, error: receipt.failure! })
      if (response.error) {
        console.error("[Raya] Browser result delivery failed; retained receipt prevents replay:", response.error)
        return
      }
      if (this.receipts.get(requestID) !== owner) return
      owner.delivered = true
      await this.retain().catch((error) =>
        console.error("[Raya] Browser receipt acknowledgement persistence failed; stale receipt remains safe", error),
      )
    } catch (error) {
      console.error("[Raya] Browser result delivery failed; retained receipt prevents replay:", error)
    }
  }

  private compact(): void {
    if (this.receipts.size < 1024) return
    for (const [id, receipt] of this.receipts) {
      if (!receipt.delivered) continue
      this.receipts.delete(id)
      if (this.receipts.size < 1024) return
    }
  }

  private restore(): void {
    const saved = this.store?.get<unknown>(journal)
    if (!saved || typeof saved !== "object") return
    const value = saved as { version?: unknown; items?: unknown; blocked?: unknown }
    if (
      value.version !== 1 ||
      !Array.isArray(value.items) ||
      value.items.length > 256 ||
      !Array.isArray(value.blocked) ||
      value.blocked.length > 64
    )
      return
    for (const id of value.blocked) if (typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) this.blocked.add(id)
    for (const item of value.items) {
      const entry = restored(item)
      if (entry) this.receipts.set(entry[0], entry[1])
    }
  }

  private retain(): Promise<void> {
    if (!this.store) return Promise.resolve()
    const items = [...this.receipts.entries()]
      .filter((entry) => !entry[1].delivered && persistable(entry[1].failure))
      .map(([id, value]) => ({ id, fingerprint: value.fingerprint, failure: value.failure }))
      .slice(-256)
    const blocked = [...this.blocked].slice(-64)
    this.writes = this.writes.then(() => Promise.resolve(this.store!.update(journal, { version: 1, items, blocked })))
    return this.writes
  }

  private interrupt(active: Active, message: string): void {
    active.controller.abort()
    active.receipt.result = undefined
    active.receipt.failure = {
      code: "disconnected",
      message,
      receipt: evidence(active.request, active.startedAt, "unknown"),
    }
    this.blocked.add(scope(active.directory))
    void this.retain().catch((error) =>
      console.error("[Raya] Interrupted browser receipt persistence failed; later actions remain paused", error),
    )
  }

  private async pause(directory: string, message: string): Promise<void> {
    this.blocked.add(scope(directory))
    await this.retain().catch((error) =>
      console.error(
        "[Raya] Browser failure receipt persistence failed; backend delivery will still be attempted",
        error,
      ),
    )
    await Promise.resolve(this.host.uncertain?.(directory, message)).catch((error) =>
      console.error("[Raya] Browser safety pause could not be shown in the host", error),
    )
  }

  resume(directory: string): void {
    if (!this.blocked.delete(scope(directory))) return
    void this.retain().catch((error) =>
      console.error("[Raya] Browser resume persistence failed; restart may restore the safety pause", error),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.offEvent()
    this.offState()
    for (const active of this.active.values()) this.interrupt(active, "Raya stopped during a browser request.")
    this.active.clear()
    this.receipts.clear()
  }
}

function identity(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max
}

function stamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function destination(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== "object") return false
  const target = value as Record<string, unknown>
  return (
    target.surface === "browser" &&
    identity(target.windowID) &&
    (target.documentID === undefined || identity(target.documentID)) &&
    (target.location === undefined || (typeof target.location === "string" && target.location.length <= 20_000))
  )
}

function proof(value: unknown): value is NonNullable<BrowserFailure["receipt"]> {
  if (!value || typeof value !== "object") return false
  const receipt = value as Record<string, unknown>
  if (!stamp(receipt.startedAt) || !stamp(receipt.finishedAt) || receipt.finishedAt < receipt.startedAt) return false
  return (
    receipt.version === 1 &&
    identity(receipt.requestID) &&
    typeof receipt.effect === "string" &&
    effects.has(receipt.effect) &&
    receipt.outcome === "unknown" &&
    (receipt.observationID === undefined || identity(receipt.observationID)) &&
    destination(receipt.target)
  )
}

function persistable(value: unknown): value is BrowserFailure & { receipt: NonNullable<BrowserFailure["receipt"]> } {
  if (!value || typeof value !== "object") return false
  const failure = value as { code?: unknown; message?: unknown; receipt?: unknown }
  if (typeof failure.code !== "string" || !codes.has(failure.code)) return false
  if (!identity(failure.message, 10_000)) return false
  return proof(failure.receipt)
}

function restored(value: unknown): [string, Receipt] | undefined {
  if (!value || typeof value !== "object") return
  const entry = value as { id?: unknown; fingerprint?: unknown; failure?: unknown }
  if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256) return
  if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) return
  if (!persistable(entry.failure) || entry.failure.receipt.requestID !== entry.id) return
  return [entry.id, { fingerprint: entry.fingerprint, failure: entry.failure }]
}
