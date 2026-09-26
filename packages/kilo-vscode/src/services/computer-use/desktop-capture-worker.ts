import { changed, DesktopCadence } from "./desktop-cadence"
import { CAPTURE, type DesktopFrame } from "./desktop-session"

export type CapturedScene = {
  frame: DesktopFrame
  sourceEpoch?: number
  sourceIdentity?: string
  sequence: number
  version: number
  capturedAt: number
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

  constructor(
    private readonly capture: () => Promise<
      (DesktopFrame & { sourceSequence?: number; sourceEpoch?: number; sourceIdentity?: string }) | undefined
    >,
    private readonly cancel: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    const generation = ++this.generation
    const cadence = new DesktopCadence(1_000)
    void this.loop(generation, cadence)
  }

  /** A passive numeric-only sample from each accepted capture, never a renewed scene. */
  onSample(listener: (sample: CaptureSample) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    this.listeners.clear()
    if (!this.running && !this.scene) return
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
    this.scene = { ...scene, sequence: ++this.sequence, capturedAt: performance.now() }
    return true
  }

  private async loop(generation: number, cadence: DesktopCadence): Promise<void> {
    while (this.running && generation === this.generation) {
      const revision = this.revision
      const frame = await this.capture().catch((error: unknown) => {
        if (generation !== this.generation) return
        this.stop()
        this.failed(error)
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
      if (!valid(frame)) {
        this.stop()
        this.failed(new Error("Continuous desktop capture exceeded its scene or memory bounds"))
        return
      }
      const { sourceSequence, sourceEpoch, sourceIdentity, ...visual } = frame
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
      }
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
