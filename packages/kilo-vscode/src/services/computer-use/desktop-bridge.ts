import { createHash, randomBytes, randomUUID } from "node:crypto"
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
import { DesktopOutcomeError, type DesktopNativeDispatch, type DesktopSession } from "./desktop-session"
import type { DesktopPlannedAction } from "./desktop-sequence"
import { NativeInputPreflightError } from "./desktop-input-host"

export interface DesktopConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

type Receipt = { fingerprint: string; result?: DesktopResult; failure?: DesktopFailure; delivered?: boolean }
type Audit = {
  hash: string
  effect: "manage" | "interact"
  outcome: "confirmed" | "unknown"
  startedAt: number
  finishedAt: number
}
type AuditEvent = {
  hash: string
  sessionHash: string
  effect: "manage" | "interact"
  phase: "pre_dispatch" | "post_dispatch"
  outcome: "refused" | "cancelled" | "confirmed" | "unknown"
  startedAt: number
  finishedAt: number
}
type NativeRow = {
  hash: string
  sessionHash: string
  requestHash: string
  sequence: number
  phase: "reserved" | "settled"
  startedAt: number
  finishedAt?: number
  outcome?: "confirmed" | "refused" | "cancelled" | "unknown"
  code?: string
  accepted?: number
  attempted?: number
}
type Journal = {
  version: 5
  epoch: string
  revision: number
  lastAckAt: number | null
  items: unknown[]
  auditSalt: string
  audit: Audit[]
  events: AuditEvent[]
  native: NativeRow[]
  nativeGeneration: number
  legacy: boolean
}
type LegacyJournal =
  | { version: 1; items: unknown[] }
  | { version: 2; epoch: string; revision: number; lastAckAt: number | null; items: unknown[] }
  | (Omit<Journal, "events" | "native" | "nativeGeneration" | "legacy" | "version"> & { version: 3 })
  | (Omit<Journal, "native" | "nativeGeneration" | "legacy" | "version"> & { version: 4 })
type CaptureRequest = Extract<DesktopRequest, { operation: "observe" | "watch" }>
type WindowsRequest = Extract<DesktopRequest, { operation: "windows" }>
type AuthorizeRequest = Extract<DesktopRequest, { operation: "authorize" }>
type AuthorizeResult = Extract<DesktopResult, { operation: "authorize" }>
type PassiveRequest = CaptureRequest | WindowsRequest | AuthorizeRequest
type ActionRequest = Exclude<DesktopRequest, PassiveRequest>
type ActionResult = Exclude<DesktopResult, { operation: "authorize" | "observe" | "watch" | "windows" }>
type Frame = Awaited<ReturnType<DesktopSession["observe"]>>
type Authorization = Exclude<DesktopRequest, { operation: "authorize" | "sequence" }>["authorization"]

const journal = "raya.computerUse.desktop.actionReceipts.v1"
const actions = new Set(["focus", "move", "drag", "click", "type", "key", "scroll", "sequence"])
const passive = new Set(["authorize", "observe", "watch", "windows"])

function nativeHash(salt: string, identity: DesktopNativeDispatch["identity"]) {
  if (
    !identity.session ||
    !identity.request ||
    identity.session.length > 256 ||
    identity.request.length > 256 ||
    !Number.isSafeInteger(identity.sequence) ||
    identity.sequence < 0
  )
    throw new Error("Native dispatch identity is invalid")
  return createHash("sha256")
    .update(`${salt}:${JSON.stringify([identity.session, identity.request, identity.sequence])}`)
    .digest("hex")
}

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

function changes(frames: Frame[]) {
  let base: Frame | undefined
  return frames.map((frame) => {
    if (
      base &&
      frame.width === base.width &&
      frame.height === base.height &&
      frame.mime === base.mime &&
      frame.observation.target.surface === base.observation.target.surface &&
      frame.observation.target.windowID === base.observation.target.windowID &&
      frame.observation.target.location === base.observation.target.location &&
      frame.data === base.data
    ) {
      return {
        change: "unchanged" as const,
        width: frame.width,
        height: frame.height,
        timing: frame.timing,
        ...(frame.semantics ? { semantics: frame.semantics } : {}),
        observation: frame.observation,
        baseObservationID: base.observation.id,
      }
    }
    base = frame
    return { ...frame, change: "keyframe" as const }
  })
}

function completeWatch(request: Extract<DesktopRequest, { operation: "watch" }>, frames: Frame[]): boolean {
  if (frames.length < 2 || frames.length > request.frameCount) return false
  if (request.mode !== "first_change_v2") return frames.length === request.frameCount
  if (frames.length === request.frameCount) return true
  return changes(frames).at(-1)?.change === "keyframe"
}

export interface DesktopReceiptStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

class DesktopAuthorizationRefusal extends Error {
  readonly name = "DesktopAuthorizationRefusal"
}

export class DesktopBridge {
  private readonly active = new Map<string, AbortController>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private writes = Promise.resolve()
  private rotation: Promise<void> | undefined
  private epoch: string = randomUUID()
  private auditSalt = randomBytes(16).toString("hex")
  private migratedAudit: Audit[] = []
  private readonly events = new Map<string, AuditEvent>()
  private readonly native = new Map<string, NativeRow>()
  private nativeGeneration = 0
  private legacy = false
  private migratedRevision = 0
  private migratedAck: number | null = null
  private committed: Journal | undefined
  private pendingAck: number | undefined
  private journalFault = false
  private journalFound = false
  private migration = false
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
    if (this.rotation) await this.rotation.catch(() => undefined)
    if (this.disposed || this.active.has(request.id)) return
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([directory, request]))
      .digest("hex")
    if (this.journalFault && actions.has(request.operation)) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: {
          code: "invalid_request",
          message: "Desktop receipt journal is invalid; native input is paused until the journal is repaired.",
        },
      })
      return
    }
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
    let dispatched = false
    let settled = false
    let interrupted: Promise<void> | undefined
    const onAbort = () => {
      if (!dispatched || settled) return
      settled = true
      receipt.failure = {
        code: "cancelled",
        message:
          "Desktop control stopped after native dispatch began. The outcome is unknown and will not be replayed.",
        receipt: {
          version: 1,
          requestID: request.id,
          startedAt,
          finishedAt: Date.now(),
          effect: effect(request),
          outcome: "unknown",
          ...ground(request),
        },
      }
      this.record(request, fingerprint, "post_dispatch", "unknown", startedAt, receipt.failure.receipt!.finishedAt)
      interrupted = this.retain(receipt)
        .catch((error) => console.error("[Raya] Interrupted desktop receipt persistence failed", error))
        .then(() => this.deliver(request.id, directory, receipt))
    }
    controller.signal.addEventListener("abort", onAbort, { once: true })
    this.active.set(request.id, controller)
    try {
      const result = await this.dispatch(
        request,
        startedAt,
        controller.signal,
        () => {
          if (controller.signal.aborted) throw new Error("Desktop action cancelled before native dispatch")
          if (request.operation !== "authorize" && request.operation !== "sequence")
            enforce(this.validate?.(authorization(request)), request.authorization)
          dispatched = true
        },
        (event) => this.nativeEvent(request, fingerprint, event),
      )
      if (controller.signal.aborted) {
        await interrupted
        return
      }
      settled = true
      await this.complete(request, directory, fingerprint, receipt, result, startedAt, dispatched)
    } catch (error) {
      if (controller.signal.aborted) {
        if (!dispatched) await this.preEvent(request, fingerprint, "cancelled", startedAt)
        await interrupted
        return
      }
      settled = true
      await this.fail(request, directory, fingerprint, receipt, error, startedAt, dispatched)
    } finally {
      controller.signal.removeEventListener("abort", onAbort)
      if (this.active.get(request.id) === controller) this.active.delete(request.id)
    }
  }

  private async complete(
    request: DesktopRequest,
    directory: string,
    fingerprint: string,
    receipt: Receipt,
    result: DesktopResult,
    startedAt: number,
    dispatched: boolean,
  ): Promise<void> {
    if (actions.has(request.operation) && !dispatched)
      throw new Error("Desktop action reported completion without native dispatch")
    receipt.result = result
    receipt.failure = undefined
    if (result.operation === "sequence") {
      const safe = { ...receipt }
      this.scrub(safe)
      this.receipts.set(request.id, safe)
    }
    const retained = this.receipts.get(request.id)!
    const proof = persistable(retained.result)
      ? retained.result.receipt
      : persistableFailure(retained.failure)
        ? retained.failure.receipt
        : undefined
    if (dispatched && proof && proof.effect !== "observe")
      this.record(request, fingerprint, "post_dispatch", proof.outcome, startedAt, proof.finishedAt)
    await this.retain(retained).catch((error) =>
      console.error("[Raya] Desktop receipt persistence failed; backend delivery will still be attempted", error),
    )
    await this.deliver(request.id, directory, receipt)
  }

  private async preEvent(
    request: DesktopRequest,
    fingerprint: string,
    outcome: "refused" | "cancelled",
    startedAt: number,
  ): Promise<void> {
    if (!actions.has(request.operation)) return
    this.record(request, fingerprint, "pre_dispatch", outcome, startedAt, Date.now())
    await this.persistJournal().catch((error) =>
      console.error("[Raya] Pre-dispatch desktop audit persistence failed", error),
    )
  }

  private async fail(
    request: DesktopRequest,
    directory: string,
    fingerprint: string,
    receipt: Receipt,
    error: unknown,
    startedAt: number,
    dispatched: boolean,
  ): Promise<void> {
    const unsent = error instanceof NativeInputPreflightError
    const uncertain = !unsent && (dispatched || error instanceof DesktopOutcomeError)
    if (unsent || (!dispatched && error instanceof DesktopAuthorizationRefusal))
      await this.preEvent(request, fingerprint, "refused", startedAt)
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
    if (uncertain)
      this.record(request, fingerprint, "post_dispatch", "unknown", startedAt, receipt.failure.receipt!.finishedAt)
    await this.retain(receipt).catch((err) =>
      console.error("[Raya] Desktop failure receipt persistence failed; backend delivery will still be attempted", err),
    )
    await this.deliver(request.id, directory, receipt)
  }

  private record(
    request: DesktopRequest,
    fingerprint: string,
    phase: AuditEvent["phase"],
    outcome: AuditEvent["outcome"],
    startedAt: number,
    finishedAt: number,
  ): void {
    if (!actions.has(request.operation)) return
    const hash = createHash("sha256").update(`${this.auditSalt}:${fingerprint}`).digest("hex")
    const sessionHash = createHash("sha256").update(`${this.auditSalt}:${request.sessionID}`).digest("hex")
    this.events.set(hash, {
      hash,
      sessionHash,
      effect: effect(request) as "manage" | "interact",
      phase,
      outcome,
      startedAt,
      finishedAt,
    })
    if (this.events.size > 256) {
      this.events.delete(this.events.keys().next().value!)
      this.nativeGeneration += 1
    }
  }

  private async nativeEvent(request: DesktopRequest, fingerprint: string, event: DesktopNativeDispatch): Promise<void> {
    if (!this.store || this.journalFault) throw new Error("Durable native dispatch evidence is unavailable")
    const hash = nativeHash(this.auditSalt, event.identity)
    const current = this.native.get(hash)
    const sessionHash = createHash("sha256").update(`${this.auditSalt}:${request.sessionID}`).digest("hex")
    const requestHash = createHash("sha256").update(`${this.auditSalt}:${fingerprint}`).digest("hex")
    if (event.phase === "reserved") {
      if (current) throw new Error("Native dispatch evidence identity conflict")
      if (this.native.size >= 255) {
        const settled = [...this.native].find((entry) => entry[1].phase === "settled")
        if (!settled) throw new Error("Native dispatch evidence capacity reached")
        this.native.delete(settled[0])
        this.nativeGeneration += 1
      }
      this.native.set(hash, {
        hash,
        sessionHash,
        requestHash,
        sequence: event.identity.sequence,
        phase: "reserved",
        startedAt: Date.now(),
      })
    } else {
      if (
        !current ||
        current.phase !== "reserved" ||
        current.sessionHash !== sessionHash ||
        current.requestHash !== requestHash
      ) {
        this.journalFault = true
        throw new Error("Native dispatch settlement has no matching reservation")
      }
      if (!validNativeOutcome(event)) {
        this.journalFault = true
        throw new Error("Native dispatch outcome is invalid")
      }
      this.native.set(hash, {
        ...current,
        phase: "settled",
        finishedAt: Date.now(),
        outcome: event.outcome,
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.accepted === undefined ? {} : { accepted: event.accepted }),
        ...(event.attempted === undefined ? {} : { attempted: event.attempted }),
      })
    }
    await this.persistJournal().catch((error: unknown) => {
      this.journalFault = true
      throw error
    })
  }

  private dispatch(
    request: DesktopRequest,
    startedAt: number,
    signal: AbortSignal,
    onDispatch: () => void,
    onNative: (event: DesktopNativeDispatch) => Promise<void>,
  ): Promise<DesktopResult> {
    if (request.operation === "authorize")
      return (
        this.authorize?.(request) ??
        Promise.resolve({ operation: "authorize", decision: "ask", reason: "No active autonomous grant" })
      )
    if (request.operation === "sequence") return this.interact(request, startedAt, onDispatch, onNative)
    const decision = this.validate?.(authorization(request))
    enforce(decision, request.authorization)
    if (request.operation === "windows") return this.windows(request, startedAt, decision)
    if (request.operation === "observe" || request.operation === "watch")
      return this.observe(request, startedAt, signal, decision)
    return this.interact(request, startedAt, onDispatch, onNative)
  }

  private async observe(
    request: CaptureRequest,
    startedAt: number,
    signal: AbortSignal,
    decision?: AuthorizeResult,
  ): Promise<DesktopResult> {
    const window = decision?.windowID ?? request.authorization?.delegation?.windowID
    const identity = decision?.identity ?? request.authorization?.delegation?.identity
    this.target(request, window)
    if (window) await this.foreground(window, identity)
    const frames = await this.capture(request, signal)
    if (window && frames.some((frame) => frame.observation.target.windowID !== window))
      throw new Error("The selected desktop window changed during observation")
    if (window) await this.foreground(window, identity)
    if (request.operation === "watch") {
      const last = frames.at(-1)
      if (!last || !completeWatch(request, frames))
        throw new Error("Desktop watch returned an incomplete frame sequence")
      return {
        operation: "watch",
        frames: changes(frames),
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
      timing: frame.timing,
      ...(frame.semantics ? { semantics: frame.semantics } : {}),
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

  private async windows(
    request: WindowsRequest,
    startedAt: number,
    decision?: AuthorizeResult,
  ): Promise<DesktopResult> {
    const window = decision?.windowID ?? request.authorization?.delegation?.windowID
    const identity = decision?.identity ?? request.authorization?.delegation?.identity
    this.target(request, window)
    const result = await this.session.windows()
    if (window && !result.windows.some((item) => item.windowID === window && item.identity === identity))
      throw new Error("The selected desktop window is no longer available")
    return {
      operation: "windows",
      windows: result.windows
        .filter((item) => !window || item.windowID === window)
        .map((window) => ({
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

  private target(request: CaptureRequest | WindowsRequest, window?: string): void {
    if (request.target && request.target.windowID !== window)
      throw new Error("The requested desktop target is outside the active selected-window grant")
  }

  private async foreground(window: string, identity?: string): Promise<void> {
    if (!identity) throw new Error("Selected desktop observation needs a stable window identity")
    const result = await this.session.windows()
    if (!result.windows.some((item) => item.windowID === window && item.identity === identity && item.foreground))
      throw new Error("The selected desktop window is no longer foreground or its identity changed")
    await this.verify(window, identity)
  }

  private async interact(
    request: ActionRequest,
    startedAt: number,
    onDispatch: () => void,
    onNative: (event: DesktopNativeDispatch) => Promise<void>,
  ): Promise<DesktopResult> {
    if (request.operation === "sequence") return this.sequence(request, startedAt, onDispatch, onNative)
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
    const decision = this.validate?.(authorization(request))
    enforce(decision, request.authorization)
    const identity = decision?.identity ?? request.authorization?.delegation?.identity
    await this.verify(request.windowID, identity)
    if (request.operation === "focus") {
      await this.session.focus(request.windowID, request.observationID, onDispatch, identity)
      return { operation: "focus", receipt: { ...receipt, effect: "manage", finishedAt: Date.now() } }
    }
    if (request.operation === "move") {
      await this.session.execute(
        {
          operation: "pointer",
          action: "move",
          windowID: request.windowID,
          observationID: request.observationID,
          sensitive: request.sensitive,
          x: request.x,
          y: request.y,
        },
        onDispatch,
        identity,
        onNative,
      )
      return { operation: "move", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "drag") {
      await this.session.execute(
        {
          operation: "drag",
          windowID: request.windowID,
          observationID: request.observationID,
          sensitive: request.sensitive,
          startX: request.startX,
          startY: request.startY,
          endX: request.endX,
          endY: request.endY,
          button: request.button,
        },
        onDispatch,
        identity,
        onNative,
      )
      return { operation: "drag", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "click") {
      await this.session.execute(
        {
          operation: "pointer",
          action: request.action,
          windowID: request.windowID,
          observationID: request.observationID,
          sensitive: request.sensitive,
          x: request.x,
          y: request.y,
          button: request.button,
        },
        onDispatch,
        identity,
        onNative,
      )
      return { operation: "click", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "type") {
      await this.session.execute(
        {
          operation: "type",
          windowID: request.windowID,
          observationID: request.observationID,
          sensitive: request.sensitive,
          text: request.text,
        },
        onDispatch,
        identity,
        onNative,
      )
      return { operation: "type", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "key") {
      await this.session.execute(
        {
          operation: "key",
          windowID: request.windowID,
          observationID: request.observationID,
          sensitive: request.sensitive,
          key: request.key,
          modifiers: request.modifiers,
        },
        onDispatch,
        identity,
        onNative,
      )
      return { operation: "key", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    await this.session.execute(
      {
        operation: "scroll",
        windowID: request.windowID,
        observationID: request.observationID,
        sensitive: request.sensitive,
        deltaX: request.deltaX,
        deltaY: request.deltaY,
      },
      onDispatch,
      identity,
      onNative,
    )
    return { operation: "scroll", receipt: { ...receipt, finishedAt: Date.now() } }
  }

  private async sequence(
    request: Extract<DesktopRequest, { operation: "sequence" }>,
    startedAt: number,
    onDispatch: () => void,
    onNative: (event: DesktopNativeDispatch) => Promise<void>,
  ): Promise<DesktopResult> {
    const proofs = new Map<object, Authorization>(request.steps.map((step) => [step.action, step.action.authorization]))
    const result = await this.session.sequence(
      {
        observationID: request.observationID,
        maxDurationMs: request.maxDurationMs,
        steps: request.steps,
      },
      async (action) => {
        const proof = proofs.get(action)
        if (!proof) throw new Error("Desktop sequence authorization evidence is incomplete")
        const decision = this.validate?.(sequenceAuthorization(request, action, proof))
        enforce(decision, proof)
        const identity = decision?.identity ?? proof.delegation?.identity
        await this.verify(action.windowID, identity)
        return identity
      },
      onDispatch,
      onNative,
      (action) => {
        const proof = proofs.get(action)
        if (!proof) throw new Error("Desktop sequence authorization evidence is incomplete")
        enforce(this.validate?.(sequenceAuthorization(request, action, proof)), proof)
      },
    )
    const frame = result.scene
    const proof = request.steps[0]?.action.authorization
    const decision = (() => {
      if (!proof) return undefined
      try {
        const value = this.validate?.(sequenceAuthorization(request, request.steps[0]!.action, proof))
        enforce(value, proof)
        return value
      } catch (error) {
        throw new DesktopOutcomeError("sequence postcondition", error instanceof Error ? error.message : String(error))
      }
    })()
    const window = decision?.windowID ?? proof?.delegation?.windowID
    if (window && frame.observation.target.windowID !== window)
      throw new DesktopOutcomeError("sequence postcondition", "The selected desktop window changed")
    if (window)
      await this.verify(window, decision?.identity ?? proof?.delegation?.identity).catch((error: unknown) => {
        throw new DesktopOutcomeError("sequence postcondition", error instanceof Error ? error.message : String(error))
      })
    return {
      operation: "sequence",
      status: result.status,
      completed: result.completed,
      ...(result.reason ? { reason: result.reason } : {}),
      width: frame.width,
      height: frame.height,
      mime: frame.mime,
      data: frame.data,
      timing: frame.timing,
      ...(frame.semantics ? { semantics: frame.semantics } : {}),
      observation: frame.observation,
      evidence: result.evidence,
      receipt: {
        version: 1,
        requestID: request.id,
        startedAt,
        finishedAt: Date.now(),
        effect: "interact",
        outcome: "confirmed",
        target: frame.observation.target,
        observationID: frame.observation.id,
      },
    }
  }

  private async verify(windowID: string, identity?: string): Promise<void> {
    if (!identity) return
    await this.session.verify(windowID, identity)
  }

  private async deliver(requestID: string, directory: string, receipt: Receipt): Promise<void> {
    try {
      const client = this.connection.getClient().kilocode.desktop
      const response = receipt.result
        ? await client.reply({ requestID, directory, result: receipt.result })
        : await client.reject({ requestID, directory, error: receipt.failure! })
      if (response.error || response.data !== true) {
        this.scrub(receipt)
        console.error("[Raya] Desktop result delivery failed; retained receipt prevents replay")
        return
      }
      const stored = this.receipts.get(requestID)
      if (!stored || stored.fingerprint !== receipt.fingerprint) return
      this.scrub(receipt)
      stored.delivered = true
      if (persistable(stored.result) || persistableFailure(stored.failure))
        this.pendingAck = Math.max(this.pendingAck ?? 0, Date.now())
      await this.retain(stored).catch((error) =>
        console.error("[Raya] Desktop receipt acknowledgement persistence failed; stale receipt remains safe", error),
      )
    } catch (error) {
      this.scrub(receipt)
      console.error("[Raya] Desktop result delivery failed; retained receipt prevents replay", error)
    }
  }

  private scrub(receipt: Receipt): void {
    if (receipt.result?.operation !== "sequence") return
    const proof = receipt.result.receipt
    receipt.result = undefined
    receipt.failure = {
      code: "invalid_request",
      message:
        "The desktop sequence ran, but its final frame is not retained after delivery. It will not be replayed; observe the desktop before continuing.",
      receipt: { ...proof, outcome: "unknown" },
    }
  }

  private compact(): void {
    if (this.receipts.size < 256) return
    const pending = new Set(this.committed?.items.map((item) => restored(item)?.[0]))
    for (const [id, receipt] of this.receipts) {
      if (!receipt.delivered) continue
      if (this.store && (!this.committed || pending.has(id))) continue
      this.receipts.delete(id)
      if (this.receipts.size < 256) return
    }
  }

  private restore(): void {
    const saved = this.store?.get<unknown>(journal)
    if (saved === undefined) return
    this.journalFound = true
    if (!validSaved(saved)) {
      this.journalFault = true
      return
    }
    const value = saved
    this.restoreMetadata(value)
    let migrated = false
    const seen = new Set<string>()
    for (const item of value.items) {
      const entry = restored(item)
      if (!entry || seen.has(entry[0])) {
        this.receipts.clear()
        this.journalFault = true
        return
      }
      seen.add(entry[0])
      if (entry[1].result?.operation === "sequence") {
        this.scrub(entry[1])
        migrated = true
      }
      this.receipts.set(entry[0], entry[1])
    }
    this.restoreEvidence(value)
    if (value.version === 5 && !migrated) this.committed = structuredClone(value)
    if (value.version !== 5 || migrated) {
      this.migration = true
      void this.persistJournal().catch((error) =>
        console.error("[Raya] Desktop receipt journal migration failed", error),
      )
    }
  }

  private restoreEvidence(value: Journal | LegacyJournal): void {
    if (value.version === 3 || value.version === 4 || value.version === 5)
      this.migratedAudit = structuredClone(value.audit)
    if (value.version === 4 || value.version === 5)
      for (const item of value.events) this.events.set(item.hash, { ...item })
    if (value.version === 5) {
      this.legacy = value.legacy
      this.nativeGeneration = value.nativeGeneration
      for (const item of value.native) this.native.set(item.hash, { ...item })
    }
    if (value.version !== 5) this.legacy = true
  }

  private restoreMetadata(value: Journal | LegacyJournal): void {
    if (value.version === 1) return
    this.epoch = value.epoch
    this.migratedRevision = value.revision
    this.migratedAck = value.lastAckAt
    if (value.version !== 2) this.auditSalt = value.auditSalt
  }

  private retain(receipt: Receipt): Promise<void> {
    if (!this.store || (!persistable(receipt.result) && !persistableFailure(receipt.failure))) return Promise.resolve()
    return this.persistJournal()
  }

  /** Read-only journal availability; an in-flight migration has no durable v3 summary yet. */
  journalState() {
    if (!this.store) return "unavailable" as const
    if (this.journalFault) return "malformed" as const
    if (this.committed) return "durable" as const
    if (this.migration) return "migrating_legacy" as const
    return this.journalFound ? ("unavailable" as const) : ("absent" as const)
  }

  /** Last durable snapshot only; never reports speculative or unacknowledged metadata. */
  journalSummary() {
    const saved = this.committed
    if (!saved) return null
    const counts = { confirmed: 0, unknown: 0 }
    for (const item of saved.items) {
      const entry = restored(item)
      if (entry?.[1].result) counts.confirmed += 1
      if (entry?.[1].failure) counts.unknown += 1
    }
    return {
      epoch: saved.epoch,
      revision: saved.revision,
      lastAckAt: saved.lastAckAt,
      pendingNative: counts,
      audit: {
        count: saved.audit.length,
        confirmed: saved.audit.filter((item) => item.outcome === "confirmed").length,
        unknown: saved.audit.filter((item) => item.outcome === "unknown").length,
      },
    }
  }

  /** Durable-only, redacted native effects for independent installed-host evaluation. */
  journalAudit() {
    const saved = this.committed
    if (!saved) return null
    return {
      epoch: saved.epoch,
      revision: saved.revision,
      entries: saved.audit.map((item) => ({ ...item })),
    }
  }

  /** Versioned host-only decisions/effects; legacy v3 audit rows have no attributable event. */
  journalEvents() {
    const saved = this.committed
    if (!saved) return null
    return {
      format: "raya.desktop-action-events" as const,
      version: 2 as const,
      epoch: saved.epoch,
      revision: saved.revision,
      events: saved.events.map((item) => ({ ...item })),
      native: saved.native.map((item) => ({ ...item })),
      nativeGeneration: saved.nativeGeneration,
      legacy: saved.legacy,
      releaseGateEligible: false as const,
    }
  }

  /** A host-only task boundary from a settled durable journal, with no private frame or target data. */
  async settledJournalAudit() {
    const write = this.writes
    const saved = await write.then(
      () => this.committed,
      () => undefined,
    )
    if (
      !saved ||
      this.disposed ||
      !this.connected ||
      this.journalFault ||
      this.migration ||
      this.active.size ||
      this.pendingAck !== undefined ||
      this.writes !== write ||
      this.committed !== saved ||
      saved.audit.length >= 256
    )
      return null
    return {
      epoch: saved.epoch,
      revision: saved.revision,
      entries: saved.audit.map((item) => ({ ...item })),
    }
  }

  /** One settled v4 snapshot for host-only task evidence; caller identity is salted and never returned raw. */
  async settledJournalEvidence(sessionID: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionID)) return null
    const write = this.writes
    const saved = await write.then(
      () => this.committed,
      () => undefined,
    )
    if (
      !saved ||
      this.disposed ||
      !this.connected ||
      this.journalFault ||
      this.migration ||
      this.active.size ||
      this.pendingAck !== undefined ||
      this.writes !== write ||
      this.committed !== saved ||
      saved.native.some((item) => item.phase === "reserved")
    )
      return null
    return {
      epoch: saved.epoch,
      revision: saved.revision,
      audit: saved.audit.map((item) => ({ ...item })),
      events: saved.events.map((item) => ({ ...item })),
      native: saved.native.map((item) => ({ ...item })),
      nativeGeneration: saved.nativeGeneration,
      legacy: saved.legacy,
      sessionHash: createHash("sha256").update(`${saved.auditSalt}:${sessionID}`).digest("hex"),
    }
  }

  /** Rotate settled evidence before opening a task boundary, preserving no-replay receipts. */
  async prepareTaskEvidence(sessionID: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionID)) return null
    if (!this.store || this.rotation || this.disposed || !this.connected || this.journalFault || this.migration)
      return null
    if (this.active.size || this.pendingAck !== undefined) return null
    const write = this.writes
    const pending = write.then(async () => {
      const saved = this.committed
      if (
        !saved ||
        this.disposed ||
        !this.connected ||
        this.journalFault ||
        this.migration ||
        this.active.size ||
        this.pendingAck !== undefined
      )
        throw new Error("Desktop task evidence is unsettled")
      if (!saved.audit.length && !saved.events.length && !saved.native.length) return
      const next: Journal = {
        ...saved,
        revision: saved.revision + 1,
        audit: [],
        events: [],
        native: [],
        nativeGeneration: saved.nativeGeneration + 1,
      }
      await Promise.resolve(this.store!.update(journal, next)).catch((error: unknown) => {
        this.journalFault = true
        throw error
      })
      this.committed = next
      this.nativeGeneration = next.nativeGeneration
      this.migratedAudit = []
      this.events.clear()
      this.native.clear()
    })
    this.rotation = pending
    this.writes = pending
    try {
      await pending
    } catch {
      return null
    } finally {
      if (this.rotation === pending) this.rotation = undefined
    }
    return this.settledJournalEvidence(sessionID)
  }

  private persistJournal(): Promise<void> {
    if (!this.store) return Promise.resolve()
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        const items = [...this.receipts.entries()]
          .filter(
            (entry) => !entry[1].delivered && (persistable(entry[1].result) || persistableFailure(entry[1].failure)),
          )
          .map(([key, value]) => ({
            id: key,
            fingerprint: value.fingerprint,
            ...(value.result?.operation === "sequence"
              ? {
                  failure: {
                    code: "invalid_request" as const,
                    message:
                      "The desktop sequence ran, but its final frame is not retained after restart. It will not be replayed; observe the desktop before continuing.",
                    receipt: { ...value.result.receipt, outcome: "unknown" as const },
                  },
                }
              : persistable(value.result)
                ? { result: value.result }
                : { failure: value.failure }),
          }))
          .slice(-256)
        const ack = this.pendingAck
        const audit = new Map((this.committed?.audit ?? this.migratedAudit).map((item) => [item.hash, item]))
        for (const value of this.receipts.values()) {
          const proof = auditProof(value)
          if (!proof || (proof.effect !== "manage" && proof.effect !== "interact")) continue
          const hash = createHash("sha256").update(`${this.auditSalt}:${value.fingerprint}`).digest("hex")
          if (this.nativeGeneration > 0 && !this.events.has(hash)) continue
          audit.set(hash, {
            hash,
            effect: proof.effect,
            outcome: proof.outcome,
            startedAt: proof.startedAt,
            finishedAt: proof.finishedAt,
          })
        }
        const saved: Journal = {
          version: 5,
          epoch: this.committed?.epoch ?? this.epoch,
          revision: this.committed ? this.committed.revision + 1 : Math.max(1, this.migratedRevision),
          lastAckAt:
            ack === undefined
              ? (this.committed?.lastAckAt ?? this.migratedAck)
              : Math.max(this.committed?.lastAckAt ?? this.migratedAck ?? 0, ack),
          items,
          auditSalt: this.auditSalt,
          audit: [...audit.values()].slice(-256),
          events: [...this.events.values()].slice(-256),
          native: [...this.native.values()],
          nativeGeneration: this.nativeGeneration + Math.max(0, audit.size - 256),
          legacy: this.legacy,
        }
        await Promise.resolve(this.store!.update(journal, saved))
        this.nativeGeneration = saved.nativeGeneration
        this.committed = saved
        this.migratedAudit = []
        this.migration = false
        if (this.pendingAck === ack) this.pendingAck = undefined
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
    // In-flight native effects must still settle into the durable receipt journal.
  }

  cancel(reason: string): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.session.takeControl(reason)
  }
}

function authorization(
  request: Exclude<DesktopRequest, AuthorizeRequest | { operation: "sequence" }>,
): AuthorizeRequest {
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
    ...("target" in request && request.target ? { target: request.target } : {}),
    ...("target" in request && request.target
      ? { windowID: request.target.windowID }
      : "windowID" in request
        ? { windowID: request.windowID }
        : request.authorization?.delegation?.windowID
          ? { windowID: request.authorization.delegation.windowID }
          : {}),
    sensitive: "sensitive" in request ? request.sensitive : false,
    ...(request.authorization?.delegation ? { delegation: request.authorization.delegation } : {}),
  }
}

function sequenceAuthorization(
  request: Extract<DesktopRequest, { operation: "sequence" }>,
  action: DesktopPlannedAction,
  proof: Authorization,
): AuthorizeRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    operation: "authorize",
    surface: "desktop",
    action:
      action.operation === "scroll"
        ? "scroll"
        : action.operation === "type" || action.operation === "key"
          ? "keyboard"
          : "pointer",
    windowID: action.windowID,
    sensitive: action.sensitive,
    ...(proof?.delegation ? { delegation: proof.delegation } : {}),
  }
}

function enforce(decision: AuthorizeResult | undefined, proof: Authorization): void {
  if (!decision) {
    if (proof?.delegation) throw new Error("Delegated desktop control cannot be revalidated")
    return
  }
  if (!proof) throw new Error("Desktop request has no authorization evidence")
  if (proof.kind === "prompt") {
    if (decision.decision === "deny")
      throw new DesktopAuthorizationRefusal(`Desktop control is no longer authorized: ${decision.reason}`)
    if (proof.delegation && decision.grantID !== proof.delegation.grantID)
      throw new Error("Delegated desktop prompt is outside its active grant")
    return
  }
  if (decision.decision === "deny")
    throw new DesktopAuthorizationRefusal(`Desktop grant is no longer authorized: ${decision.reason}`)
  if (decision.decision !== "allow" || decision.grantID !== proof.grantID)
    throw new Error(`Desktop grant is no longer authorized: ${decision.reason}`)
}

function auditProof(value: Receipt) {
  if (persistable(value.result)) return value.result.receipt
  if (persistableFailure(value.failure)) return value.failure.receipt
  return undefined
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

function validSaved(value: unknown): value is Journal | LegacyJournal {
  if (!value || typeof value !== "object") return false
  const saved = value as {
    version?: unknown
    items?: unknown
    epoch?: unknown
    revision?: unknown
    lastAckAt?: unknown
    auditSalt?: unknown
    audit?: unknown
    events?: unknown
    native?: unknown
    nativeGeneration?: unknown
    legacy?: unknown
  }
  if (!Array.isArray(saved.items) || saved.items.length > 256) return false
  if (saved.version === 1) return true
  if (!validJournal(saved)) return false
  if (saved.version === 2) return true
  if (
    (saved.version !== 3 && saved.version !== 4 && saved.version !== 5) ||
    typeof saved.auditSalt !== "string" ||
    !/^[a-f0-9]{32}$/.test(saved.auditSalt)
  )
    return false
  if (!validRows(saved.audit, validAudit)) return false
  if (saved.version === 3) return true
  if (!validRows(saved.events, validEvent)) return false
  if (saved.version === 4) return true
  return (
    typeof saved.legacy === "boolean" &&
    Number.isSafeInteger(saved.nativeGeneration) &&
    (saved.nativeGeneration as number) >= 0 &&
    validRows(saved.native, validNative)
  )
}

function validNativeOutcome(value: { outcome?: unknown; code?: unknown; accepted?: unknown; attempted?: unknown }) {
  if (typeof value.outcome !== "string" || !["confirmed", "refused", "cancelled", "unknown"].includes(value.outcome))
    return false
  if (value.code !== undefined && (typeof value.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)))
    return false
  if (value.accepted !== undefined && (!Number.isSafeInteger(value.accepted) || (value.accepted as number) < 0))
    return false
  if (value.attempted !== undefined && (!Number.isSafeInteger(value.attempted) || (value.attempted as number) < 0))
    return false
  if ((value.accepted === undefined) !== (value.attempted === undefined)) return false
  if (
    value.accepted !== undefined &&
    value.attempted !== undefined &&
    (value.accepted as number) > (value.attempted as number)
  )
    return false
  return true
}

function validNative(value: unknown): value is NativeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const keys = Object.keys(item).sort().join(",")
  if (item.phase === "reserved" && keys !== "hash,phase,requestHash,sequence,sessionHash,startedAt") return false
  if (
    item.phase === "settled" &&
    ![
      "finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
      "code,finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
      "accepted,attempted,finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
      "accepted,attempted,code,finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
    ].includes(keys)
  )
    return false
  if (item.phase !== "reserved" && item.phase !== "settled") return false
  if (
    ![item.hash, item.sessionHash, item.requestHash].every(
      (part) => typeof part === "string" && /^[a-f0-9]{64}$/.test(part),
    )
  )
    return false
  if (!Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0) return false
  if (!Number.isSafeInteger(item.startedAt) || (item.startedAt as number) <= 0) return false
  if (item.phase === "reserved") return true
  if (!validTimes(item.startedAt, item.finishedAt)) return false
  return validNativeOutcome(item)
}

function validRows<T extends { hash: string }>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value) || value.length > 256) return false
  const hashes = new Set<string>()
  for (const item of value) {
    if (!check(item) || hashes.has(item.hash)) return false
    hashes.add(item.hash)
  }
  return true
}

function validEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(",") !== "effect,finishedAt,hash,outcome,phase,sessionHash,startedAt") return false
  if (typeof item.hash !== "string" || !/^[a-f0-9]{64}$/.test(item.hash)) return false
  if (typeof item.sessionHash !== "string" || !/^[a-f0-9]{64}$/.test(item.sessionHash)) return false
  if (item.effect !== "manage" && item.effect !== "interact") return false
  if (item.phase === "pre_dispatch" && item.outcome !== "refused" && item.outcome !== "cancelled") return false
  if (item.phase === "post_dispatch" && item.outcome !== "confirmed" && item.outcome !== "unknown") return false
  if (item.phase !== "pre_dispatch" && item.phase !== "post_dispatch") return false
  return validTimes(item.startedAt, item.finishedAt)
}

function validTimes(startedAt: unknown, finishedAt: unknown) {
  return (
    Number.isSafeInteger(startedAt) &&
    (startedAt as number) > 0 &&
    Number.isSafeInteger(finishedAt) &&
    (finishedAt as number) >= (startedAt as number)
  )
}

function validAudit(value: unknown): value is Audit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).sort().join(",") === "effect,finishedAt,hash,outcome,startedAt" &&
    typeof item.hash === "string" &&
    /^[a-f0-9]{64}$/.test(item.hash) &&
    (item.effect === "manage" || item.effect === "interact") &&
    (item.outcome === "confirmed" || item.outcome === "unknown") &&
    Number.isSafeInteger(item.startedAt) &&
    (item.startedAt as number) > 0 &&
    Number.isSafeInteger(item.finishedAt) &&
    (item.finishedAt as number) >= (item.startedAt as number)
  )
}

function validJournal(value: {
  version?: unknown
  items?: unknown
  epoch?: unknown
  revision?: unknown
  lastAckAt?: unknown
}): boolean {
  return (
    (value.version === 2 || value.version === 3 || value.version === 4 || value.version === 5) &&
    Array.isArray(value.items) &&
    value.items.length <= 256 &&
    typeof value.epoch === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.epoch) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    (value.lastAckAt === null || (Number.isSafeInteger(value.lastAckAt) && (value.lastAckAt as number) > 0))
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
