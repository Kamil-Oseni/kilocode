import { randomUUID } from "node:crypto"
import { locate, TargetError, type BrowserTarget, type TargetElement, type TargetPage } from "./browser-target"

export interface DocumentFrame extends TargetPage {
  url(): string
  name(): string
  parentFrame(): DocumentFrame | null
  childFrames(): DocumentFrame[]
  isDetached(): boolean
}

export interface FrameOwner {
  frames(): DocumentFrame[]
  mainFrame(): DocumentFrame
  on(event: "frameattached" | "framenavigated" | "framedetached", listener: (frame: DocumentFrame) => void): void
  off(event: "frameattached" | "framenavigated" | "framedetached", listener: (frame: DocumentFrame) => void): void
}

export type FrameInfo = { id: string; tabID: string; parentID?: string; url: string; name: string; main: boolean }

export class FrameRegistry {
  private readonly ids = new Map<DocumentFrame, string>()
  private readonly documents = new Map<string, DocumentFrame>()
  private disposed = false
  private readonly change = (frame: DocumentFrame) => this.invalidate(frame)

  constructor(
    private readonly owner: FrameOwner,
    private readonly tabID: string,
  ) {
    owner.on("framenavigated", this.change)
    owner.on("framedetached", this.change)
  }

  private invalidate(frame: DocumentFrame): void {
    const id = this.ids.get(frame)
    if (id) this.documents.delete(id)
    this.ids.delete(frame)
    for (const child of frame.childFrames()) this.invalidate(child)
  }

  private identity(frame: DocumentFrame): string {
    const previous = this.ids.get(frame)
    if (previous) return previous
    const id = randomUUID()
    this.ids.set(frame, id)
    this.documents.set(id, frame)
    return id
  }

  list(): FrameInfo[] {
    if (this.disposed) throw new TargetError("Browser frame registry was closed")
    return this.owner
      .frames()
      .filter((frame) => !frame.isDetached())
      .map((frame) => ({
        id: this.identity(frame),
        tabID: this.tabID,
        parentID: frame.parentFrame() ? this.identity(frame.parentFrame()!) : undefined,
        url: frame.url(),
        name: frame.name(),
        main: frame === this.owner.mainFrame(),
      }))
  }

  lease(id?: string) {
    if (id === undefined) id = this.identity(this.owner.mainFrame())
    const frame = this.documents.get(id)
    const check = () => {
      if (
        this.disposed ||
        !frame ||
        frame.isDetached() ||
        !this.owner.frames().includes(frame) ||
        this.documents.get(id) !== frame
      )
        throw new TargetError(
          "Browser frame document is stale, detached, or belongs to another tab. Observe frames again; no fallback was used.",
        )
    }
    check()
    const document = frame!
    return {
      id,
      frame: document,
      check,
      element: async (target: BrowserTarget): Promise<TargetElement> => {
        check()
        const locator = await locate(document, target)
        if (!locator.count || (await locator.count()) !== 1)
          throw new TargetError("Browser frame target must match exactly one element")
        check()
        const element = await locator.elementHandle?.()
        if (!element) throw new TargetError("Browser frame target disappeared before it could be bound")
        try {
          check()
        } catch (error) {
          await element.dispose?.()
          throw error
        }
        return element
      },
    }
  }

  async resolve(parent: string, selector: string): Promise<FrameInfo> {
    const lease = this.lease(parent)
    const element = await lease.element(selector)
    try {
      const frame = await element.contentFrame?.()
      lease.check()
      if (!frame || frame.isDetached() || frame.parentFrame() !== lease.frame)
        throw new TargetError("Observed selector did not resolve to a live direct child iframe")
      const result = this.list().find((item) => item.id === this.identity(frame))
      if (!result) throw new TargetError("Browser iframe disappeared during resolution")
      return result
    } finally {
      await element.dispose?.()
    }
  }

  dispose(): void {
    this.disposed = true
    this.owner.off("framenavigated", this.change)
    this.owner.off("framedetached", this.change)
    this.ids.clear()
    this.documents.clear()
  }
}
