// raya_change - Milestone F testable CLI-to-Playwright browser bridge
import { DialogPendingError } from "./browser-dialog"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type {
  BrowserFailure,
  BrowserRequest,
  BrowserResult as HostBrowserResult,
  EventKilocodeBrowserCancelled,
  EventKilocodeBrowserRequested,
  KiloClient,
  KilocodeBrowserConfirmationResponse,
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

type ActionRequest = Exclude<BrowserRequest, { operation: "authorize" }>

function action({ confirmation: _, ...request }: ActionRequest): BrowserAction {
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
  if ("authorization" in request) {
    const { authorization: _, ...input } = request
    return input
  }
  return request
}

type Seal = NonNullable<Extract<BrowserRequest, { operation: "click" }>["confirmation"]>
type Completion = {
  version: 1
  identity: string
  invocation: string
  ack: string
  requestID: string
  operation: ActionRequest["operation"]
  outcome: "confirmed" | "refused" | "cancelled" | "unknown"
  startedAt: number
  finishedAt: number
  resultDigest?: string
}
type Receipt = {
  fingerprint: string
  operation?: ActionRequest["operation"]
  startedAt?: number
  result?: HostBrowserResult
  failure?: BrowserFailure
  delivered?: boolean
  proof?: Seal
  invocation?: string
  dispatched?: boolean
  attempted?: boolean
  completion?: Completion
}
type AuthorizeRequest = Extract<BrowserRequest, { operation: "authorize" }>
type AuthorizeResult = Extract<HostBrowserResult, { operation: "authorize" }>
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
const unknownMessage = "A browser action has an unknown outcome. Inspect the destination before resuming control."
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
const authorized = new Set([
  "upload",
  "download",
  "dialog",
  "tabs",
  "frames",
  "navigate",
  "snapshot",
  "click",
  "type",
  "select",
  "scroll",
  "screenshot",
  "evaluate",
  "smoke",
])

function scope(directory: string) {
  return createHash("sha256").update(directory).digest("hex")
}

function digest(value: unknown, legacy = false) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value
        return Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            legacy ? left.localeCompare(right) : left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      }),
    )
    .digest("hex")
}

function deadline<T>(task: Promise<T>): Promise<T> {
  const clock = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const timeout = new Promise<never>((_resolve, reject) => {
    clock.id = setTimeout(() => reject(new Error("Browser recovery request timed out")), 2_000)
  })
  return Promise.race([task, timeout]).finally(() => {
    if (clock.id) clearTimeout(clock.id)
  })
}

function fingerprint(request: BrowserRequest, directory: string) {
  return digest([directory, request], true)
}

function bound(request: ActionRequest, directory: string) {
  const { id: _, confirmation: __, ...input } = request
  return { scope: boundScope(directory), digest: digest(input) }
}

function boundScope(directory: string) {
  const root = path.resolve(directory)
  const scoped = process.platform === "win32" ? root.toLowerCase() : root
  return createHash("sha256").update(scoped).digest("hex")
}

function effect(request: Pick<BrowserRequest, "operation">) {
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
  private readonly inflight = new Set<string>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly settling = new Map<string, Promise<void>>()
  private readonly blocked = new Set<string>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private writes = Promise.resolve()
  private revision = 0
  private connected = false
  private disposed = false
  private fault = false

  constructor(
    private readonly connection: BrowserConnection,
    private readonly host: BrowserHost,
    private readonly store?: BrowserReceiptStore,
    private readonly authorize?: (request: AuthorizeRequest) => Promise<AuthorizeResult>,
    private readonly validate?: (request: AuthorizeRequest) => AuthorizeResult,
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
      for (const [id, receipt] of this.receipts) {
        if (!receipt.proof || receipt.proof.scope !== boundScope(directory)) continue
        if (this.disposed || revision !== this.revision) return
        await this.settle(id, directory, receipt).catch((error) =>
          console.error("[Raya] Browser confirmation remains retained for later recovery", error),
        )
      }
      const response = await deadline(this.connection.getClient().kilocode.browser.list({ directory })).catch(
        (error) => {
          console.error("[Raya] Browser pending list could not be read during recovery", error)
          return undefined
        },
      )
      if (!response) continue
      if (response.error) {
        console.error("[Raya] BrowserBridge: request recovery failed:", response.error)
        continue
      }
      for (const request of response.data ?? []) {
        void this.run(request, directory, true)
      }
    }
  }

  private settle(requestID: string, directory: string, receipt: Receipt): Promise<void> {
    if (receipt.delivered) return Promise.resolve()
    const prior = this.settling.get(requestID)
    if (prior) return prior
    const controller = new AbortController()
    const clock = { id: undefined as ReturnType<typeof setTimeout> | undefined }
    const timeout = new Promise<never>((_resolve, reject) => {
      clock.id = setTimeout(() => {
        controller.abort()
        reject(new Error("Browser confirmation timed out; receipt remains retained"))
      }, 2_000)
    })
    const task = Promise.race([this.settleOne(requestID, directory, receipt, controller.signal), timeout]).finally(
      () => {
        if (clock.id) clearTimeout(clock.id)
        if (this.settling.get(requestID) === task) this.settling.delete(requestID)
      },
    )
    this.settling.set(requestID, task)
    return task
  }

  private async settleOne(
    requestID: string,
    directory: string,
    receipt: Receipt,
    signal: AbortSignal,
    retried = false,
  ): Promise<void> {
    if (!receipt.proof || !receipt.operation) return
    if (this.active.has(requestID)) return
    const client = this.connection.getClient().kilocode.browser
    const response = await client.confirmation({ requestID, directory, proof: receipt.proof }, { signal })
    if (signal.aborted || this.active.has(requestID) || this.inflight.has(requestID)) return
    if (response.error || !response.data) return
    const status = response.data
    if (status.completion && !status.dispatch) {
      await this.reconcile(requestID, directory, receipt, receipt, signal)
      return
    }
    if (!status.dispatch) {
      await this.settleIdle(requestID, directory, receipt, status.pending, signal, retried)
      return
    }
    await this.settleGranted(requestID, directory, receipt, status.dispatch, status.completion, signal)
  }

  private async settleIdle(
    requestID: string,
    directory: string,
    receipt: Receipt,
    pending: boolean,
    signal: AbortSignal,
    retried: boolean,
  ): Promise<void> {
    if (!receipt.proof || !receipt.invocation) return
    if (pending) {
      const reply = await this.connection.getClient().kilocode.browser.reject(
        {
          requestID,
          directory,
          proof: receipt.proof,
          invocation: receipt.invocation,
          error: { code: "cancelled", message: "Browser work stopped before native dispatch; it was not replayed." },
        },
        { signal },
      )
      if (signal.aborted) return
      if (reply.error) {
        if (!retried) await this.settleOne(requestID, directory, receipt, signal, true)
        return
      }
      await this.reconcile(requestID, directory, receipt, receipt, signal)
      return
    }
    if (signal.aborted) return
    receipt.delivered = true
    await this.retain()
  }

  private async settleGranted(
    requestID: string,
    directory: string,
    receipt: Receipt,
    dispatch: NonNullable<KilocodeBrowserConfirmationResponse["dispatch"]>,
    completion: KilocodeBrowserConfirmationResponse["completion"],
    signal: AbortSignal,
  ): Promise<void> {
    if (!receipt.proof || !receipt.operation) return
    if (signal.aborted || this.active.has(requestID) || this.inflight.has(requestID)) return
    if (dispatch.invocation !== receipt.invocation || dispatch.identity !== receipt.proof.identity) return
    receipt.dispatched = true
    if (!completion) {
      const at = Math.max(Date.now(), dispatch.at, receipt.startedAt ?? 0)
      receipt.completion =
        receipt.completion?.outcome === "unknown" && receipt.completion.invocation === dispatch.invocation
          ? receipt.completion
          : {
              version: 1,
              identity: receipt.proof.identity,
              invocation: dispatch.invocation,
              ack: randomUUID(),
              requestID,
              operation: receipt.operation,
              outcome: "unknown",
              startedAt: at,
              finishedAt: at,
            }
      receipt.failure = {
        code: "disconnected",
        message:
          "The interrupted browser action has an unknown outcome. Inspect the destination before resuming control.",
        receipt: {
          version: 1,
          requestID,
          startedAt: at,
          finishedAt: at,
          effect: effect({ operation: receipt.operation }),
          outcome: "unknown",
        },
      }
      await this.pause(directory, receipt.failure.message)
      if (signal.aborted || this.active.has(requestID)) return
      const confirmed = await this.connection
        .getClient()
        .kilocode.browser.confirm(
          { requestID, directory, proof: receipt.proof, completion: receipt.completion },
          { signal },
        )
      if (signal.aborted || confirmed.error || !confirmed.data) return
    }
    await this.reconcile(requestID, directory, receipt, receipt, signal)
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
        this.check(request)
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

  private admit(request: ActionRequest, directory: string, hash: string, recovered: boolean): Admission | undefined {
    if (this.fault)
      return this.refuse(
        request,
        directory,
        hash,
        "Saved browser safety state could not be read or retained. This request was not dispatched. Review the saved state before restoring browser control.",
      )
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
          if (prior.delivered) return
          if (prior.proof) {
            await this.settle(request.id, directory, prior)
            return
          }
          if (persistable(prior.failure)) await this.pause(directory, prior.failure.message)
          await this.deliver(request.id, directory, prior)
        })(),
      }
    }
    // Reserve room for every admitted action: even an observation can finish with an unknown outcome.
    // Memento writes are not cross-host claims; this bounds only this bridge's active and retained state.
    if (this.store) {
      const pending = [...this.receipts.values()].filter((receipt) => !receipt.delivered).length
      const scopes = new Set([
        ...this.blocked,
        ...[...this.active.values()].map((entry) => scope(entry.directory)),
        scope(directory),
      ])
      if (pending >= 256 || scopes.size > 64)
        return this.refuse(
          request,
          directory,
          hash,
          "Browser safety storage is full of unresolved work. This request was not dispatched. Review unresolved outcomes before continuing.",
        )
    }
    if (
      effect(request) !== "observe" &&
      (this.blocked.has(scope(directory)) || this.blocked.has(boundScope(directory)))
    ) {
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
      operation: request.operation,
      startedAt: Date.now(),
      ...("confirmation" in request && request.confirmation
        ? { proof: request.confirmation, invocation: randomUUID() }
        : {}),
      failure: {
        code: "cancelled",
        message:
          "This browser request was already admitted but its outcome is unconfirmed. It will not be dispatched again. Inspect the destination before repeating the action with a new request.",
      },
    }
    this.receipts.set(request.id, receipt)
    if (!recovered) return { receipt }
    const startedAt = receipt.startedAt ?? Date.now()
    receipt.failure = {
      code: "invalid_request",
      message:
        "Recovered browser request has no local execution receipt. Its prior outcome is unknown, so it was not replayed. Inspect the destination before issuing a fresh request.",
      ...(effect(request) !== "observe" ? { receipt: evidence(request, startedAt, "unknown") } : {}),
    }
    return {
      settle: (async () => {
        if (receipt.proof) {
          await this.retain()
          await this.settle(request.id, directory, receipt)
          return
        }
        if (persistable(receipt.failure)) await this.pause(directory, receipt.failure.message)
        await this.deliver(request.id, directory, receipt)
      })(),
    }
  }

  private refuse(request: BrowserRequest, directory: string, hash: string, message: string): Admission {
    return {
      settle: this.deliver(request.id, directory, {
        fingerprint: hash,
        failure: { code: "invalid_request", message },
      }),
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

  private check(request: ActionRequest): void {
    if (this.fault) throw new Error("Browser safety state is unavailable; input was refused before dispatch")
    const decision = this.validate?.(authorization(request))
    if (!("authorization" in request)) {
      if (decision?.decision === "deny") throw new Error(`Browser control is no longer authorized: ${decision.reason}`)
      return
    }
    if (request.authorization.source === "lease") {
      if (!decision || decision.decision !== "allow")
        throw new Error(
          `Browser lease authorization is no longer valid: ${decision?.reason ?? "local revalidation is unavailable"}`,
        )
      if (decision.grantID !== request.authorization.grantID)
        throw new Error("Browser lease authorization changed grants before dispatch")
      return
    }
    if (decision?.decision === "deny") throw new Error(`Browser control is no longer authorized: ${decision.reason}`)
  }

  private async dispatch(request: ActionRequest, directory: string, receipt: Receipt, controller: AbortController) {
    if (!receipt.proof)
      throw new Error("Browser request lacks durable confirmation; update the backend before controlling the browser")
    const binding = bound(request, directory)
    if (receipt.proof.scope !== binding.scope || receipt.proof.digest !== binding.digest)
      throw new Error("Browser request changed after admission; no action was dispatched")
    this.check(request)
    await this.show(request, directory)
    if (controller.signal.aborted) return false
    this.check(request)
    receipt.attempted = true
    this.inflight.add(request.id)
    const response = await this.connection
      .getClient()
      .kilocode.browser.dispatch({
        requestID: request.id,
        directory,
        browserDispatchInput: { proof: receipt.proof, invocation: receipt.invocation! },
      })
      .finally(() => this.inflight.delete(request.id))
    if (response.error || !response.data?.granted) {
      if (await this.reconcile(request.id, directory, receipt)) return false
      throw new BrowserOutcomeError(
        request.operation,
        "Browser dispatch ownership was not confirmed; no automatic retry is allowed",
      )
    }
    receipt.dispatched = true
    // Native input cannot begin until the one-use dispatch grant is durable locally.
    await this.retain()
    if (controller.signal.aborted) return false
    this.check(request)
    return true
  }

  private complete(request: ActionRequest, receipt: Receipt, result: HostBrowserResult, startedAt: number): void {
    if (receipt.proof)
      receipt.completion = {
        version: 1,
        identity: receipt.proof.identity,
        invocation: receipt.invocation!,
        ack: randomUUID(),
        requestID: request.id,
        operation: request.operation,
        outcome: "confirmed",
        startedAt,
        finishedAt: "receipt" in result && result.receipt ? result.receipt.finishedAt : Date.now(),
        resultDigest: digest(result),
      }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 64_000) {
      receipt.result = result
      receipt.failure = undefined
      return
    }
    receipt.failure = {
      code: "invalid_request",
      message:
        "This browser request completed, but its result exceeds the retained receipt limit. It will not execute again. Inspect the destination for the result.",
    }
  }

  private async run(request: BrowserRequest, directory: string, recovered = false): Promise<void> {
    if (this.disposed) return
    if (request.operation === "authorize") {
      await this.authorization(request, directory)
      return
    }
    const hash = fingerprint(request, directory)
    const admission = this.admit(request, directory, hash, recovered)
    if (!admission) return
    if ("settle" in admission) {
      await admission.settle
      return
    }
    const receipt = admission.receipt
    const controller = new AbortController()
    const startedAt = receipt.startedAt ?? Date.now()
    this.active.set(request.id, { controller, request, directory, startedAt, receipt })
    const state = { completed: false, ambiguous: false }
    try {
      // Preserve the one-use invocation before asking the backend for ownership.
      await this.retain()
      if (!(await this.dispatch(request, directory, receipt, controller))) return
      const value = await this.host.execute({
        ...action(request),
        origin: { requestID: request.id, sessionID: request.sessionID, directory },
        uploader: this.uploader(request, directory),
        guard: () => {
          if (controller.signal.aborted) throw new Error("Browser request was cancelled before native dispatch")
          this.check(request)
        },
      })
      const result = Object.assign(value, {
        receipt: evidence(request, startedAt, "confirmed", value),
      }) as HostBrowserResult
      state.completed = true
      if (controller.signal.aborted) return
      this.complete(request, receipt, result, startedAt)
      await this.retain()
      await this.deliver(request.id, directory, { fingerprint: hash, result }, receipt)
    } catch (error) {
      if (controller.signal.aborted) return
      state.ambiguous = await this.fail(request, directory, receipt, startedAt, state.completed, error)
    } finally {
      if (this.active.get(request.id)?.controller === controller) this.active.delete(request.id)
      if ((controller.signal.aborted || state.ambiguous) && receipt.proof && this.connected)
        void this.settle(request.id, directory, receipt).catch((error) =>
          console.error("[Raya] Interrupted browser action remains retained for recovery", error),
        )
    }
  }

  private async fail(
    request: ActionRequest,
    directory: string,
    receipt: Receipt,
    startedAt: number,
    completed: boolean,
    error: unknown,
  ): Promise<boolean> {
    if (receipt.proof && receipt.attempted && !receipt.dispatched) {
      receipt.failure = {
        code: "disconnected",
        message: "Browser dispatch ownership is uncertain. The action will not be replayed.",
        receipt: evidence(request, startedAt, "unknown"),
      }
      await this.pause(directory, receipt.failure.message)
      return true
    }
    receipt.failure = this.failed(request, startedAt, completed, error)
    if (receipt.proof && !receipt.completion)
      receipt.completion = {
        version: 1,
        identity: receipt.proof.identity,
        invocation: receipt.invocation!,
        ack: randomUUID(),
        requestID: request.id,
        operation: request.operation,
        outcome: receipt.failure.receipt?.outcome === "unknown" ? "unknown" : "refused",
        startedAt,
        finishedAt: Date.now(),
      }
    if (receipt.failure.receipt) await this.pause(directory, receipt.failure.message)
    await this.retain().catch((error) =>
      console.error("[Raya] Browser failure receipt persistence failed; input remains paused", error),
    )
    await this.deliver(request.id, directory, receipt)
    return false
  }

  private async authorization(request: AuthorizeRequest, directory: string): Promise<void> {
    const result =
      (await this.authorize?.(request)) ??
      ({ operation: "authorize", decision: "ask", reason: "No active autonomous grant" } as const)
    const response = await this.connection
      .getClient()
      .kilocode.browser.reply({ requestID: request.id, directory, result: { ...result, confirmationVersion: 1 } })
    if (response.error) console.error("[Raya] Browser authorization delivery failed:", response.error)
  }

  private async deliver(requestID: string, directory: string, receipt: Receipt, owner = receipt): Promise<void> {
    try {
      const client = this.connection.getClient().kilocode.browser
      if (!(await this.confirm(requestID, directory, owner, receipt))) return
      const response = receipt.result
        ? await client.reply({ requestID, directory, result: receipt.result })
        : await client.reject({ requestID, directory, error: receipt.failure! })
      if (response.error) {
        if (owner.proof && (await this.reconcile(requestID, directory, owner, receipt))) return
        console.error("[Raya] Browser result delivery failed; retained receipt prevents replay:", response.error)
        return
      }
      if (this.receipts.get(requestID) !== owner) return
      if (owner.proof && owner.dispatched && owner.completion) {
        const response = await client.acknowledge({
          requestID,
          directory,
          proof: owner.proof,
          ack: owner.completion.ack,
        })
        if (response.error || !response.data) return
      }
      owner.delivered = true
      await this.retain().catch((error) =>
        console.error("[Raya] Browser receipt acknowledgement persistence failed; stale receipt remains safe", error),
      )
    } catch (error) {
      if (owner.proof && (await this.reconcile(requestID, directory, owner, receipt))) return
      console.error("[Raya] Browser result delivery failed; retained receipt prevents replay:", error)
    }
  }

  private async confirm(requestID: string, directory: string, owner: Receipt, receipt: Receipt): Promise<boolean> {
    if (!owner.proof || !owner.dispatched || !owner.completion) return true
    const response = await this.connection.getClient().kilocode.browser.confirm({
      requestID,
      directory,
      proof: owner.proof,
      completion: owner.completion,
    })
    if (!response.error && response.data) return true
    await this.reconcile(requestID, directory, owner, receipt)
    return false
  }

  private async reconcile(
    requestID: string,
    directory: string,
    receipt: Receipt,
    payload = receipt,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!receipt.proof) return false
    try {
      const client = this.connection.getClient().kilocode.browser
      const response = await client.confirmation({ requestID, directory, proof: receipt.proof }, { signal })
      if (signal?.aborted) return false
      const completion = response.data?.completion
      if (response.error || !completion) return false
      if (!this.same(requestID, receipt, completion)) return false
      // Historical native confirmation does not reconstruct a missing page payload or reopen model work.
      receipt.completion = completion
      if (completion.outcome === "unknown") {
        await this.unknown(requestID, directory, receipt, completion)
        if (signal?.aborted) return false
      }
      if (response.data?.pending) {
        if (!(await this.publish(requestID, directory, receipt, payload, completion, signal))) return false
      }
      if (!(await this.ack(requestID, directory, receipt.proof, completion.ack, signal))) return false
      receipt.delivered = true
      await this.retain()
      return true
    } catch {
      return false
    }
  }

  private async ack(
    requestID: string,
    directory: string,
    proof: Seal,
    token: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false
    const response = await this.connection
      .getClient()
      .kilocode.browser.acknowledge({ requestID, directory, proof, ack: token }, { signal })
    return !signal?.aborted && !response.error && !!response.data
  }

  private same(requestID: string, receipt: Receipt, completion: Completion): boolean {
    if (!receipt.proof) return false
    if (receipt.completion && !isDeepStrictEqual(completion, receipt.completion)) return false
    return (
      completion.identity === receipt.proof.identity &&
      completion.invocation === receipt.invocation &&
      completion.requestID === requestID &&
      completion.operation === receipt.operation
    )
  }

  private async unknown(requestID: string, directory: string, receipt: Receipt, completion: Completion): Promise<void> {
    receipt.result = undefined
    receipt.failure = {
      code: "invalid_request",
      message: unknownMessage,
      receipt: {
        version: 1,
        requestID,
        startedAt: completion.startedAt,
        finishedAt: completion.finishedAt,
        effect: effect({ operation: completion.operation }),
        outcome: "unknown",
      },
    }
    await this.pause(directory, receipt.failure.message)
  }

  private async publish(
    requestID: string,
    directory: string,
    receipt: Receipt,
    payload: Receipt,
    completion: Completion,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const client = this.connection.getClient().kilocode.browser
    const result = payload.result ?? receipt.result
    const response =
      result && completion.outcome === "confirmed" && digest(result) === completion.resultDigest
        ? await client.reply({ requestID, directory, result }, { signal })
        : await client.reject(
            {
              requestID,
              directory,
              error: receipt.failure ?? {
                code: "invalid_request",
                message:
                  "The browser action has a retained completion receipt, but the original result payload is unavailable. Do not repeat the action. Use a fresh authorized observation to inspect the destination.",
              },
            },
            { signal },
          )
    return !signal?.aborted && !response.error
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
    const saved = (() => {
      try {
        return this.store?.get<unknown>(journal)
      } catch {
        this.fault = true
        console.error("[Raya] Browser safety journal could not be read; browser actions remain paused")
        return undefined
      }
    })()
    if (saved === undefined) return
    this.fault = true
    if (!saved || typeof saved !== "object") return
    const value = saved as { version?: unknown; items?: unknown; blocked?: unknown }
    if (
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.items) ||
      value.items.length > 256 ||
      !Array.isArray(value.blocked) ||
      value.blocked.length > 64
    )
      return
    const blocked = new Set<string>()
    const items = new Map<string, Receipt>()
    for (const id of value.blocked) {
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || blocked.has(id)) return
      blocked.add(id)
    }
    for (const item of value.items) {
      const entry = restored(item, value.version)
      if (!entry || items.has(entry[0])) return
      items.set(entry[0], entry[1])
    }
    this.install(blocked, items)
  }

  private install(blocked: Set<string>, items: Map<string, Receipt>): void {
    for (const id of blocked) this.blocked.add(id)
    for (const [id, receipt] of items) {
      this.receipts.set(id, receipt)
      // A process can die after the backend grants dispatch but before the local grant write completes.
      if (receipt.proof) this.blocked.add(receipt.proof.scope)
    }
    if (this.blocked.size > 64) return
    this.fault = false
  }

  private retain(): Promise<void> {
    if (!this.store) return Promise.resolve()
    if (this.fault)
      return Promise.reject(new Error("Browser safety journal is quarantined; saved evidence was preserved"))
    const items = [...this.receipts.entries()]
      .filter((entry) => !entry[1].delivered && (entry[1].proof || persistable(entry[1].failure)))
      .map(([id, value]) => ({
        id,
        fingerprint: value.fingerprint,
        ...(value.proof ? { proof: value.proof } : {}),
        ...(value.invocation ? { invocation: value.invocation } : {}),
        ...(value.operation ? { operation: value.operation } : {}),
        ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
        ...(value.dispatched ? { dispatched: true } : {}),
        ...(value.completion ? { completion: value.completion } : {}),
        ...(persistable(value.failure)
          ? {
              failure: {
                code: value.failure.code,
                message: unknownMessage,
                receipt: {
                  version: 1 as const,
                  requestID: id,
                  startedAt: value.failure.receipt.startedAt,
                  finishedAt: value.failure.receipt.finishedAt,
                  effect: value.failure.receipt.effect,
                  outcome: "unknown" as const,
                },
              },
            }
          : {}),
      }))
    const blocked = [...this.blocked]
    if (items.length > 256 || blocked.length > 64) {
      this.fault = true
      return Promise.reject(
        new Error("Browser safety journal capacity exceeded; unresolved evidence was not truncated"),
      )
    }
    this.writes = this.writes
      .then(() => Promise.resolve(this.store!.update(journal, { version: 2, items, blocked })))
      .catch(() => {
        this.fault = true
        throw new Error("Browser safety journal could not be retained; later requests will not be dispatched")
      })
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
    if (this.connected && active.receipt.dispatched && active.receipt.proof)
      void this.writes
        .then(() => this.settle(active.request.id, active.directory, active.receipt))
        .catch((error) => console.error("[Raya] Interrupted browser confirmation remains retained for recovery", error))
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
    if (this.fault) return
    const prior = this.blocked.delete(scope(directory))
    const current = this.blocked.delete(boundScope(directory))
    if (!prior && !current) return
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

function authorization(request: ActionRequest): AuthorizeRequest {
  const action =
    request.operation === "snapshot" ||
    request.operation === "screenshot" ||
    request.operation === "frames" ||
    (request.operation === "tabs" && request.action === "list") ||
    (request.operation === "dialog" && request.action === "list")
      ? "observe"
      : request.operation === "scroll"
        ? "scroll"
        : request.operation === "upload" || request.operation === "download"
          ? "files"
          : "browser"
  const windowID = "tabID" in request && request.tabID ? request.tabID : undefined
  if (!("authorization" in request)) {
    // Profile and authentication requests originate inside the extension. Model-originated actions require evidence;
    // queued requests from older backends fail closed after an upgrade instead of inheriting a new grant implicitly.
    if (authorized.has(request.operation)) throw new Error("Browser action is missing immutable authorization evidence")
    return {
      id: request.id,
      sessionID: request.sessionID,
      operation: "authorize",
      surface: "browser",
      action,
      ...(windowID ? { windowID } : {}),
      sensitive: false,
    }
  }
  const proof = request.authorization
  if (proof.sessionID !== request.sessionID || proof.action !== action || proof.windowID !== windowID)
    throw new Error("Browser action does not match its immutable authorization evidence")
  return {
    id: request.id,
    sessionID: request.sessionID,
    operation: "authorize",
    surface: "browser",
    action,
    ...(windowID ? { windowID } : {}),
    sensitive: proof.sensitive,
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

type Saved = {
  id?: unknown
  fingerprint?: unknown
  failure?: unknown
  proof?: unknown
  invocation?: unknown
  operation?: unknown
  startedAt?: unknown
  dispatched?: unknown
  completion?: unknown
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function savedProof(value: unknown): value is Seal {
  if (!value || typeof value !== "object") return false
  const seal = value as Record<string, unknown>
  return (
    seal.version === 1 &&
    uuid(seal.identity) &&
    Number.isInteger(seal.slot) &&
    Number(seal.slot) >= 0 &&
    Number(seal.slot) <= 255 &&
    hash(seal.scope) &&
    hash(seal.digest)
  )
}

function savedCompletion(value: unknown, entry: Saved): value is Completion {
  if (!value || typeof value !== "object" || !savedProof(entry.proof)) return false
  const completion = value as Record<string, unknown>
  return (
    entry.dispatched === true &&
    completion.version === 1 &&
    completion.identity === entry.proof.identity &&
    completion.invocation === entry.invocation &&
    completion.requestID === entry.id &&
    completion.operation === entry.operation &&
    uuid(completion.ack) &&
    ["confirmed", "refused", "cancelled", "unknown"].includes(String(completion.outcome)) &&
    stamp(completion.startedAt) &&
    stamp(completion.finishedAt) &&
    completion.finishedAt >= completion.startedAt &&
    (completion.outcome !== "confirmed" || hash(completion.resultDigest)) &&
    (completion.resultDigest === undefined || hash(completion.resultDigest))
  )
}

function safeFailure(value?: BrowserFailure): boolean {
  return !value || (!!value.receipt && value.receipt.target === undefined && value.receipt.observationID === undefined)
}

function redacted(value: BrowserFailure & { receipt: NonNullable<BrowserFailure["receipt"]> }) {
  return {
    code: value.code,
    message: unknownMessage,
    receipt: {
      version: 1 as const,
      requestID: value.receipt.requestID,
      startedAt: value.receipt.startedAt,
      finishedAt: value.receipt.finishedAt,
      effect: value.receipt.effect,
      outcome: "unknown" as const,
    },
  }
}

function restored(value: unknown, version: 1 | 2): [string, Receipt] | undefined {
  if (!value || typeof value !== "object") return
  const entry = value as Saved
  if (!identity(entry.id, 256) || !hash(entry.fingerprint)) return
  if (entry.failure !== undefined && !persistable(entry.failure)) return
  const failure = persistable(entry.failure) ? entry.failure : undefined
  if (failure && failure.receipt.requestID !== entry.id) return
  if (version === 1) {
    if (!failure) return
    return [entry.id, { fingerprint: entry.fingerprint, failure: redacted(failure) }]
  }
  return restoredV2({ ...entry, id: entry.id, fingerprint: entry.fingerprint }, failure)
}

function restoredV2(
  entry: Saved & { id: string; fingerprint: string },
  failure?: BrowserFailure & { receipt: NonNullable<BrowserFailure["receipt"]> },
): [string, Receipt] | undefined {
  if (entry.proof === undefined) {
    if (!failure || entry.invocation !== undefined || entry.completion !== undefined || entry.dispatched !== undefined)
      return
    return [entry.id, { fingerprint: entry.fingerprint, failure: redacted(failure) }]
  }
  if (!savedProof(entry.proof) || !uuid(entry.invocation) || !stamp(entry.startedAt)) return
  if (typeof entry.operation !== "string" || !authorized.has(entry.operation)) return
  if (entry.dispatched !== undefined && entry.dispatched !== true) return
  if (!safeFailure(failure)) return
  if (entry.completion !== undefined && !savedCompletion(entry.completion, entry)) return
  return [
    entry.id,
    {
      fingerprint: entry.fingerprint,
      proof: entry.proof,
      invocation: entry.invocation,
      operation: entry.operation as ActionRequest["operation"],
      startedAt: entry.startedAt,
      ...(entry.dispatched ? { dispatched: true } : {}),
      ...(entry.completion ? { completion: entry.completion as Completion } : {}),
      ...(failure ? { failure: redacted(failure) } : {}),
    },
  ]
}
