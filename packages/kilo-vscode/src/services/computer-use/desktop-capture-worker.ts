import { changed, DesktopCadence } from "./desktop-cadence"
import { CAPTURE, type DesktopFrame } from "./desktop-session"

export type CapturedScene = {
  frame: DesktopFrame
  sequence: number
  version: number
  capturedAt: number
}

export class DesktopCaptureWorker {
  private generation = 0
  private sequence = 0
  private version = 0
  private token: number | undefined
  private scene: CapturedScene | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private wake: (() => void) | undefined
  private running = false

  constructor(
    private readonly capture: () => Promise<DesktopFrame & { sourceSequence?: number }>,
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

  stop(): void {
    if (!this.running && !this.scene) return
    this.running = false
    this.generation += 1
    this.scene = undefined
    this.token = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.wake?.()
    this.wake = undefined
    this.cancel()
  }

  latest(maxAgeMs = 125): CapturedScene | undefined {
    if (!this.running || !this.scene) return
    if (performance.now() - this.scene.capturedAt > maxAgeMs) return
    return this.scene
  }

  renew(base: number, target: Pick<DesktopFrame, "windowID" | "location" | "width" | "height">): boolean {
    const scene = this.scene
    if (
      !this.running ||
      !scene ||
      !Number.isSafeInteger(base) ||
      this.token !== base ||
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
      const frame = await this.capture().catch((error: unknown) => {
        if (generation !== this.generation) return
        this.stop()
        this.failed(error)
      })
      if (!frame || !this.running || generation !== this.generation) return
      if (
        !frame.windowID ||
        !frame.location ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        frame.width > CAPTURE.edge ||
        frame.height > CAPTURE.edge ||
        frame.width * frame.height > CAPTURE.pixels ||
        (frame.sourceSequence !== undefined &&
          (!Number.isSafeInteger(frame.sourceSequence) || frame.sourceSequence < 1)) ||
        Buffer.byteLength(frame.data, "ascii") > CAPTURE.data
      ) {
        this.stop()
        this.failed(new Error("Continuous desktop capture exceeded its scene or memory bounds"))
        return
      }
      const { sourceSequence, ...visual } = frame
      const previous = this.scene?.frame
      const updated = changed(previous, visual)
      this.token = sourceSequence
      this.scene = {
        frame: visual,
        sequence: ++this.sequence,
        version: updated ? ++this.version : this.version,
        capturedAt: performance.now(),
      }
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
