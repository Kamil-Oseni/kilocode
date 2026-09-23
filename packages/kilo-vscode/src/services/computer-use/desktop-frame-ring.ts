export const FRAME_RING = { count: 4, data: 25_000_000 } as const

type Frame = { data: string; observation: { id: string } }

export class DesktopFrameRing<T extends Frame> {
  private readonly frames = new Map<string, T>()
  private total = 0

  constructor(
    private readonly count = FRAME_RING.count,
    private readonly budget = FRAME_RING.data,
  ) {
    if (!Number.isInteger(count) || count <= 0) throw new Error("Desktop frame ring capacity must be positive")
    if (!Number.isInteger(budget) || budget <= 0) throw new Error("Desktop frame ring byte budget must be positive")
  }

  get(id: string): T | undefined {
    return this.frames.get(id)
  }

  set(frame: T): void {
    const id = frame.observation.id
    const bytes = Buffer.byteLength(frame.data, "ascii")
    if (!id) throw new Error("Desktop frame ring requires an observation identity")
    if (bytes > this.budget) throw new Error("Desktop frame exceeds the ephemeral ring byte budget")
    this.delete(id)
    this.frames.set(id, frame)
    this.total += bytes
    while (this.frames.size > this.count || this.total > this.budget) this.delete(this.frames.keys().next().value!)
  }

  delete(id: string): void {
    const frame = this.frames.get(id)
    if (!frame) return
    this.total -= Buffer.byteLength(frame.data, "ascii")
    this.frames.delete(id)
  }

  clear(): void {
    this.frames.clear()
    this.total = 0
  }

  size(): { frames: number; bytes: number } {
    return { frames: this.frames.size, bytes: this.total }
  }
}
