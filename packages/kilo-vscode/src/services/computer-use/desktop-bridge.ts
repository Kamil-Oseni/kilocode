import { createHash } from "node:crypto"
import type {
  DesktopFailure,
  DesktopRequest,
  DesktopResult,
  EventKilocodeDesktopCancelled,
  EventKilocodeDesktopRequested,
  KiloClient,
} from "@kilocode/sdk/v2/client"
import type { ConnectionState } from "../cli-backend/connection-service"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import { DesktopOutcomeError, type DesktopSession } from "./desktop-session"

export interface DesktopConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

type Receipt = { fingerprint: string; result?: DesktopResult; failure?: DesktopFailure; delivered?: boolean }
type CaptureRequest = Extract<DesktopRequest, { operation: "observe" | "watch" }>
type WindowsRequest = Extract<DesktopRequest, { operation: "windows" }>
type AuthorizeRequest = Extract<DesktopRequest, { operation: "authorize" }>
type AuthorizeResult = Extract<DesktopResult, { operation: "authorize" }>
type PassiveRequest = CaptureRequest | WindowsRequest | AuthorizeRequest
type ActionRequest = Exclude<DesktopRequest, PassiveRequest>
type ActionResult = Exclude<DesktopResult, { operation: "authorize" | "observe" | "watch" | "windows" }>
type Frame = Awaited<ReturnType<DesktopSession["observe"]>>

const journal = "raya.computerUse.desktop.actionReceipts.v1"
const actions = new Set(["focus", "move", "drag", "click", "type", "key", "scroll"])
const passive = new Set(["authorize", "observe", "watch", "windows"])

function effect(request: DesktopRequest) {
  if (passive.has(request.operation)) return "observe" as const
  if (request.operation === "focus") return "manage" as const
  return "interact" as const
}

function ground(request: DesktopRequest) {
  if (passive.has(request.operation)) return {}
  const action = request as ActionRequest
  return {
    target: { surface: "desktop" as const, windowID: action.windowID },
    observationID: action.observationID,
  }
}

export interface DesktopReceiptStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

export class DesktopBridge {
  private readonly active = new Map<string, AbortController>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private writes = Promise.resolve()
  private revision = 0
  private connected = false
  private disposed = false

  constructor(
    private readonly connection: DesktopConnection,
    private readonly session: DesktopSession,
    private readonly capture: (request: CaptureRequest, signal: AbortSignal) => Promise<Frame[]>,
    private readonly store?: DesktopReceiptStore,
    private readonly authorize?: (request: AuthorizeRequest) => Promise<AuthorizeResult>,
    private readonly validate?: (request: AuthorizeRequest) => AuthorizeResult,
  ) {
    this.restore()
    this.offEvent = connection.onEvent((event, directory) => this.event(event, directory))
    this.offState = connection.onStateChange((state) => this.state(state))
  }

  private event(event: SSEPayload, directory?: string): void {
    const value = event as unknown as EventKilocodeDesktopRequested | EventKilocodeDesktopCancelled
    if (value.type === "kilocode.desktop.cancelled") {
      const controller = this.active.get(value.properties.requestID)
      controller?.abort()
      this.active.delete(value.properties.requestID)
      if (controller) this.session.takeControl("The agent desktop observation was cancelled.")
      return
    }
    if (value.type !== "kilocode.desktop.requested" || !directory) return
    void this.run(value.properties, directory)
  }

  private state(state: ConnectionState): void {
    if (state === "connected") {
      this.connected = true
      const revision = ++this.revision
      void this.recover(revision).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        console.error("[Raya] Desktop request recovery read failed; no work replayed:", detail.slice(0, 1000))
      })
      return
    }
    if (!this.connected || (state !== "disconnected" && state !== "error")) return
    this.connected = false
    this.revision += 1
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.session.takeControl("Raya disconnected. Resume desktop control after reconnecting.")
  }

  private async recover(revision: number): Promise<void> {
    for (const directory of this.connection.getKnownDirectories()) {
      if (this.disposed || revision !== this.revision) return
      const response = await this.connection.getClient().kilocode.desktop.list({ directory })
      if (response.error) continue
      for (const request of response.data ?? []) void this.run(request, directory, true)
    }
  }

  private async run(request: DesktopRequest, directory: string, recovered = false): Promise<void> {
    if (this.disposed || this.active.has(request.id)) return
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([directory, request]))
      .digest("hex")
    const prior = this.receipts.get(request.id)
    if (prior && prior.fingerprint !== fingerprint) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: { code: "invalid_request", message: "Desktop request ID was reused with different content." },
      })
      return
    }
    if (prior) {
      await this.deliver(request.id, directory, prior)
      return
    }
    this.compact()
    if (this.receipts.size >= 256) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: { code: "invalid_request", message: "Desktop receipt capacity reached; no capture was performed." },
      })
      return
    }
    const receipt: Receipt = {
      fingerprint,
      failure: {
        code: "cancelled",
        message: "This desktop request was admitted but its outcome is unconfirmed. It will not be replayed.",
      },
    }
    this.receipts.set(request.id, receipt)
    if (recovered) {
      receipt.failure = {
        code: "invalid_request",
        message: "Recovered desktop request has no local receipt. Its prior outcome is unknown and was not replayed.",
      }
      await this.deliver(request.id, directory, receipt)
      return
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    this.active.set(request.id, controller)
    try {
      const result = await this.dispatch(request, startedAt, controller.signal)
      if (controller.signal.aborted) return
      receipt.result = result
      receipt.failure = undefined
      await this.retain(receipt).catch((error) =>
        console.error("[Raya] Desktop receipt persistence failed; backend delivery will still be attempted", error),
      )
      await this.deliver(request.id, directory, receipt)
    } catch (error) {
      if (controller.signal.aborted) return
      const uncertain = error instanceof DesktopOutcomeError
      receipt.failure = {
        code: "invalid_request",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 10_000),
        ...(uncertain
          ? {
              receipt: {
                version: 1 as const,
                requestID: request.id,
                startedAt,
                finishedAt: Date.now(),
                effect: effect(request),
                outcome: "unknown" as const,
                ...ground(request),
              },
            }
          : {}),
      }
      if (uncertain) this.session.takeControl("A desktop action had an uncertain outcome. Inspect it before resuming.")
      await this.retain(receipt).catch((error) =>
        console.error(
          "[Raya] Desktop failure receipt persistence failed; backend delivery will still be attempted",
          error,
        ),
      )
      await this.deliver(request.id, directory, receipt)
    } finally {
      if (this.active.get(request.id) === controller) this.active.delete(request.id)
    }
  }

  private dispatch(request: DesktopRequest, startedAt: number, signal: AbortSignal): Promise<DesktopResult> {
    if (request.operation === "authorize")
      return (
        this.authorize?.(request) ??
        Promise.resolve({ operation: "authorize", decision: "ask", reason: "No active autonomous grant" })
      )
    const decision = this.validate?.(authorization(request))
    if (decision && decision.decision !== "allow")
      throw new Error(`Desktop control is no longer authorized: ${decision.reason}`)
    if (request.operation === "windows") return this.windows(request, startedAt)
    if (request.operation === "observe" || request.operation === "watch")
      return this.observe(request, startedAt, signal)
    return this.interact(request, startedAt)
  }

  private async observe(request: CaptureRequest, startedAt: number, signal: AbortSignal): Promise<DesktopResult> {
    const frames = await this.capture(request, signal)
    if (request.operation === "watch") {
      const last = frames.at(-1)
      if (frames.length !== request.frameCount || !last)
        throw new Error("Desktop watch returned an incomplete frame sequence")
      return {
        operation: "watch",
        frames,
        receipt: {
          version: 1,
          requestID: request.id,
          startedAt,
          finishedAt: Date.now(),
          effect: "observe",
          outcome: "confirmed",
          target: last.observation.target,
          observationID: last.observation.id,
        },
      }
    }
    const frame = frames[0]
    if (!frame || frames.length !== 1) throw new Error("Desktop observation returned an invalid frame sequence")
    return {
      operation: "observe",
      width: frame.width,
      height: frame.height,
      mime: frame.mime,
      data: frame.data,
      observation: frame.observation,
      receipt: {
        version: 1,
        requestID: request.id,
        startedAt,
        finishedAt: Date.now(),
        effect: "observe",
        outcome: "confirmed",
        target: frame.observation.target,
        observationID: frame.observation.id,
      },
    }
  }

  private async windows(request: WindowsRequest, startedAt: number): Promise<DesktopResult> {
    const result = await this.session.windows()
    return {
      operation: "windows",
      windows: result.windows.map((window) => ({
        windowID: window.windowID,
        title: window.title,
        processID: window.processID,
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height,
        minimized: window.minimized,
        foreground: window.foreground,
      })),
      observation: result.observation,
      receipt: {
        version: 1,
        requestID: request.id,
        startedAt,
        finishedAt: Date.now(),
        effect: "observe",
        outcome: "confirmed",
        target: result.observation.target,
        observationID: result.observation.id,
      },
    }
  }

  private async interact(request: ActionRequest, startedAt: number): Promise<DesktopResult> {
    const receipt = {
      version: 1 as const,
      requestID: request.id,
      startedAt,
      finishedAt: 0,
      effect: "interact" as const,
      outcome: "confirmed" as const,
      target: { surface: "desktop" as const, windowID: request.windowID },
      observationID: request.observationID,
    }
    if (request.operation === "focus") {
      await this.session.focus(request.windowID, request.observationID)
      return { operation: "focus", receipt: { ...receipt, effect: "manage", finishedAt: Date.now() } }
    }
    if (request.operation === "move") {
      await this.session.execute({
        operation: "pointer",
        action: "move",
        windowID: request.windowID,
        observationID: request.observationID,
        x: request.x,
        y: request.y,
      })
      return { operation: "move", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "drag") {
      await this.session.execute({
        operation: "drag",
        windowID: request.windowID,
        observationID: request.observationID,
        startX: request.startX,
        startY: request.startY,
        endX: request.endX,
        endY: request.endY,
        button: request.button,
      })
      return { operation: "drag", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "click") {
      await this.session.execute({
        operation: "pointer",
        action: request.action,
        windowID: request.windowID,
        observationID: request.observationID,
        x: request.x,
        y: request.y,
        button: request.button,
      })
      return { operation: "click", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "type") {
      await this.session.execute({
        operation: "type",
        windowID: request.windowID,
        observationID: request.observationID,
        text: request.text,
      })
      return { operation: "type", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "key") {
      await this.session.execute({
        operation: "key",
        windowID: request.windowID,
        observationID: request.observationID,
        key: request.key,
        modifiers: request.modifiers,
      })
      return { operation: "key", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    await this.session.execute({
      operation: "scroll",
      windowID: request.windowID,
      observationID: request.observationID,
      deltaX: request.deltaX,
      deltaY: request.deltaY,
    })
    return { operation: "scroll", receipt: { ...receipt, finishedAt: Date.now() } }
  }

  private async deliver(requestID: string, directory: string, receipt: Receipt): Promise<void> {
    try {
      const client = this.connection.getClient().kilocode.desktop
      const response = receipt.result
        ? await client.reply({ requestID, directory, result: receipt.result })
        : await client.reject({ requestID, directory, error: receipt.failure! })
      if (response.error || response.data !== true) {
        console.error("[Raya] Desktop result delivery failed; retained receipt prevents replay")
        return
      }
      if (this.receipts.get(requestID) !== receipt) return
      receipt.delivered = true
      await this.retain(receipt).catch((error) =>
        console.error("[Raya] Desktop receipt acknowledgement persistence failed; stale receipt remains safe", error),
      )
    } catch (error) {
      console.error("[Raya] Desktop result delivery failed; retained receipt prevents replay", error)
    }
  }

  private compact(): void {
    if (this.receipts.size < 256) return
    for (const [id, receipt] of this.receipts) {
      if (!receipt.delivered) continue
      this.receipts.delete(id)
      if (this.receipts.size < 256) return
    }
  }

  private restore(): void {
    const saved = this.store?.get<unknown>(journal)
    if (!saved || typeof saved !== "object") return
    const value = saved as { version?: unknown; items?: unknown }
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 256) return
    for (const item of value.items) {
      const entry = restored(item)
      if (entry) this.receipts.set(entry[0], entry[1])
    }
  }

  private retain(receipt: Receipt): Promise<void> {
    if (!this.store || (!persistable(receipt.result) && !persistableFailure(receipt.failure))) return Promise.resolve()
    this.writes = this.writes.then(() => {
      const items = [...this.receipts.entries()]
        .filter(
          (entry) => !entry[1].delivered && (persistable(entry[1].result) || persistableFailure(entry[1].failure)),
        )
        .map(([key, value]) => ({
          id: key,
          fingerprint: value.fingerprint,
          ...(persistable(value.result) ? { result: value.result } : { failure: value.failure }),
        }))
        .slice(-256)
      return Promise.resolve(this.store!.update(journal, { version: 1, items }))
    })
    return this.writes
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.offEvent()
    this.offState()
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.receipts.clear()
  }

  cancel(reason: string): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.session.takeControl(reason)
  }
}

function authorization(request: Exclude<DesktopRequest, AuthorizeRequest>): AuthorizeRequest {
  const action =
    request.operation === "observe" || request.operation === "watch" || request.operation === "windows"
      ? "observe"
      : request.operation === "focus"
        ? "window"
        : request.operation === "scroll"
          ? "scroll"
          : request.operation === "type" || request.operation === "key"
            ? "keyboard"
            : "pointer"
  return {
    id: request.id,
    sessionID: request.sessionID,
    operation: "authorize",
    surface: "desktop",
    action,
    ...("windowID" in request ? { windowID: request.windowID } : {}),
    sensitive: false,
  }
}

function persistable(value: unknown): value is ActionResult {
  if (!value || typeof value !== "object") return false
  const result = value as { operation?: unknown; receipt?: unknown }
  if (typeof result.operation !== "string" || !actions.has(result.operation)) return false
  if (!result.receipt || typeof result.receipt !== "object") return false
  const receipt = result.receipt as Record<string, unknown>
  return (
    receipt.version === 1 &&
    typeof receipt.requestID === "string" &&
    Number.isFinite(receipt.startedAt) &&
    Number.isFinite(receipt.finishedAt) &&
    ((result.operation === "focus" && receipt.effect === "manage") ||
      (result.operation !== "focus" && receipt.effect === "interact")) &&
    receipt.outcome === "confirmed" &&
    typeof receipt.observationID === "string" &&
    !!receipt.target &&
    typeof receipt.target === "object" &&
    (receipt.target as Record<string, unknown>).surface === "desktop" &&
    typeof (receipt.target as Record<string, unknown>).windowID === "string"
  )
}

function persistableFailure(
  value: unknown,
): value is DesktopFailure & { receipt: NonNullable<DesktopFailure["receipt"]> } {
  if (!value || typeof value !== "object") return false
  const failure = value as { code?: unknown; message?: unknown; receipt?: unknown }
  if (typeof failure.code !== "string" || typeof failure.message !== "string" || !failure.receipt) return false
  if (failure.message.length < 1 || failure.message.length > 10_000 || typeof failure.receipt !== "object") return false
  const receipt = failure.receipt as Record<string, unknown>
  const target = receipt.target as Record<string, unknown> | undefined
  return (
    receipt.version === 1 &&
    typeof receipt.requestID === "string" &&
    Number.isFinite(receipt.startedAt) &&
    Number.isFinite(receipt.finishedAt) &&
    (receipt.effect === "manage" || receipt.effect === "interact") &&
    receipt.outcome === "unknown" &&
    typeof receipt.observationID === "string" &&
    target?.surface === "desktop" &&
    typeof target.windowID === "string"
  )
}

function restored(value: unknown): [string, Receipt] | undefined {
  if (!value || typeof value !== "object") return
  const entry = value as { id?: unknown; fingerprint?: unknown; result?: unknown; failure?: unknown }
  if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256) return
  if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) return
  const result = persistable(entry.result) ? entry.result : undefined
  const failure = persistableFailure(entry.failure) ? entry.failure : undefined
  if (!result && !failure) return
  if (result && result.receipt.requestID !== entry.id) return
  if (failure && failure.receipt.requestID !== entry.id) return
  return [entry.id, { fingerprint: entry.fingerprint, ...(result ? { result } : { failure }) }]
}
