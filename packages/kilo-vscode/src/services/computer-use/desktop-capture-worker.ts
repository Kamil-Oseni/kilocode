import { changed, DesktopCadence } from "./desktop-cadence"
import { CAPTURE, type DesktopFrame } from "./desktop-session"

export type CapturedScene = {
  frame: DesktopFrame
  sourceEpoch?: number
  sourceIdentity?: string
  sequence: number
  version: number
  capturedAt: number
  origin: {
    requested?: number
    received: number
    accepted: number
    acquisition?: { lower: number; upper: number; uncertainty: number }
  }
}

export type CaptureEvent = {
  kind: "frame" | "continuity" | "consumer" | "start" | "stop" | "failure"
  at: number
  requested?: number
  received?: number
  accepted?: number
  acquisition?: { lower: number; upper: number; uncertainty: number }
  acquisitionMs?: number
  preparationMs?: number
  unchanged?: 1
}

export type CaptureSample = {
  capturedAtMs: number
  acquisitionMs: number
  preparationMs: number
  totalMs: number
  semanticsMs?: number
}

function valid(frame: DesktopFrame & { sourceSequence?: number; sourceEpoch?: number; sourceIdentity?: string }) {
  return (
    !!frame.windowID &&
    !!frame.location &&
    frame.width > 0 &&
    frame.height > 0 &&
    frame.width <= CAPTURE.edge &&
    frame.height <= CAPTURE.edge &&
    frame.width * frame.height <= CAPTURE.pixels &&
    (frame.sourceSequence === undefined || (Number.isSafeInteger(frame.sourceSequence) && frame.sourceSequence > 0)) &&
    (frame.sourceEpoch === undefined || (Number.isSafeInteger(frame.sourceEpoch) && frame.sourceEpoch > 0)) &&
    (frame.sourceIdentity === undefined || /^[A-F0-9]{64}$/.test(frame.sourceIdentity)) &&
    Buffer.byteLength(frame.data, "ascii") <= CAPTURE.data
  )
}

function receipt(received: number, accepted: number) {
  return Number.isFinite(received) && received >= 0 && received <= accepted
}

export class DesktopCaptureWorker {
  private generation = 0
  private sequence = 0
  private version = 0
  private revision = 0
  private token: number | undefined
  private scene: CapturedScene | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private wake: (() => void) | undefined
  private running = false
  private readonly listeners = new Set<(sample: CaptureSample) => void>()
  private readonly events = new Set<(event: CaptureEvent) => void>()

  constructor(
    private readonly capture: () => Promise<
      | (DesktopFrame & {
          sourceSequence?: number
          sourceEpoch?: number
          sourceIdentity?: string
          sourceReceivedAtMs?: number
          sourceAcquisition?: CaptureEvent["acquisition"]
        })
      | undefined
    >,
    private readonly cancel: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.emit({ kind: "start", at: performance.now() })
    const generation = ++this.generation
    const cadence = new DesktopCadence(1_000)
    void this.loop(generation, cadence)
  }

  /** A passive numeric-only sample from each accepted capture, never a renewed scene. */
  onSample(listener: (sample: CaptureSample) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onEvent(listener: (event: CaptureEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  private emit(event: CaptureEvent) {
    for (const listener of this.events) {
      try {
        listener(Object.freeze(event))
      } catch {
        console.error("[Raya] Desktop timing listener failed")
      }
    }
  }

  consume(scene: CapturedScene) {
    if (!this.running || this.scene?.sequence !== scene.sequence) return
    this.emit({ kind: "consumer", at: performance.now(), ...scene.origin })
  }

  fail(error: unknown) {
    this.emit({ kind: "failure", at: performance.now() })
    this.stop()
    this.failed(error)
  }

  stop(): void {
    this.listeners.clear()
    if (!this.running && !this.scene) return
    this.emit({ kind: "stop", at: performance.now() })
    this.running = false
    this.generation += 1
    this.revision += 1
    this.scene = undefined
    this.token = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.wake?.()
    this.wake = undefined
    this.cancel()
  }

  dispose(): void {
    this.stop()
    this.events.clear()
  }

  invalidate(): void {
    if (!this.running) return
    this.revision += 1
    this.scene = undefined
    this.token = undefined
  }

  latest(maxAgeMs = 125): CapturedScene | undefined {
    if (!this.running || !this.scene) return
    if (performance.now() - this.scene.capturedAt > maxAgeMs) return
    return this.scene
  }

  renew(
    base: number,
    target: Pick<DesktopFrame, "windowID" | "location" | "width" | "height"> & {
      epoch?: number
      identity?: string
      acquisition?: CaptureEvent["acquisition"]
    },
  ): boolean {
    const scene = this.scene
    if (
      !this.running ||
      !scene ||
      !Number.isSafeInteger(base) ||
      this.token !== base ||
      scene.sourceEpoch !== target.epoch ||
      scene.sourceIdentity !== target.identity ||
      scene.frame.windowID !== target.windowID ||
      scene.frame.location !== target.location ||
      scene.frame.width !== target.width ||
      scene.frame.height !== target.height
    )
      return false
    const now = performance.now()
    this.scene = {
      ...scene,
      sequence: ++this.sequence,
      capturedAt: now,
      origin: { received: now, accepted: now, acquisition: target.acquisition },
    }
    this.emit({ kind: "continuity", at: now, ...this.scene.origin })
    return true
  }

  private async loop(generation: number, cadence: DesktopCadence): Promise<void> {
    while (this.running && generation === this.generation) {
      const revision = this.revision
      const requested = performance.now()
      const frame = await this.capture().catch((error: unknown) => {
        if (generation !== this.generation) return
        this.fail(error)
      })
      if (!this.running || generation !== this.generation) return
      if (revision !== this.revision) continue
      if (!frame) {
        this.scene = undefined
        this.token = undefined
        await new Promise<void>((resolve) => {
          this.wake = resolve
          this.timer = setTimeout(resolve, cadence.next(false))
        })
        this.wake = undefined
        this.timer = undefined
        continue
      }
      const { sourceSequence, sourceEpoch, sourceIdentity, sourceReceivedAtMs, sourceAcquisition, ...visual } = frame
      const accepted = performance.now()
      const received = sourceReceivedAtMs ?? accepted
      if (!valid(frame) || !receipt(received, accepted)) {
        this.fail(new Error("Continuous desktop capture exceeded its scene, clock or memory bounds"))
        return
      }
      const previous = this.scene?.frame
      const updated = changed(previous, visual)
      this.token = sourceSequence
      this.scene = {
        frame: visual,
        sourceEpoch,
        sourceIdentity,
        sequence: ++this.sequence,
        version: updated ? ++this.version : this.version,
        capturedAt: performance.now(),
        origin: { ...(requested <= received ? { requested } : {}), received, accepted, acquisition: sourceAcquisition },
      }
      this.emit({
        kind: "frame",
        at: accepted,
        ...this.scene.origin,
        acquisitionMs: frame.timing.acquisitionMs,
        preparationMs: frame.timing.preparationMs,
        ...(!updated ? { unchanged: 1 as const } : {}),
      })
      if (this.listeners.size) {
        const sample = Object.freeze({
          capturedAtMs: this.scene.capturedAt,
          acquisitionMs: frame.timing.acquisitionMs,
          preparationMs: frame.timing.preparationMs,
          totalMs: frame.timing.totalMs,
          ...(frame.timing.semanticsMs === undefined ? {} : { semanticsMs: frame.timing.semanticsMs }),
        })
        for (const listener of this.listeners) {
          try {
            listener(sample)
          } catch {
            console.error("[Raya] Desktop capture metrics listener failed")
          }
        }
      }
      if (!this.running || generation !== this.generation) return
      const delay = cadence.next(updated)
      await new Promise<void>((resolve) => {
        this.wake = resolve
        this.timer = setTimeout(resolve, delay)
      })
      this.wake = undefined
      this.timer = undefined
    }
  }
}
