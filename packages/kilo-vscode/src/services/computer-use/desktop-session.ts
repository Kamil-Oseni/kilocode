import { ObservationLedger, type ComputerObservation, type ComputerTarget } from "./observation-ledger"

export type DesktopFrame = {
  windowID: string
  location?: string
  width: number
  height: number
  mime: "image/png" | "image/jpeg"
  data: string
}

export type DesktopAction = {
  windowID: string
  observationID: string
} & (
  | { operation: "pointer"; action: "move" | "click" | "double_click"; x: number; y: number; button?: "left" | "right" }
  | { operation: "type"; text: string }
  | { operation: "key"; key: string; modifiers?: readonly ("alt" | "control" | "meta" | "shift")[] }
  | { operation: "scroll"; deltaX: number; deltaY: number }
)

export type DesktopState = {
  control: "agent" | "manual"
  busy: boolean
  reason?: string
}

export interface DesktopDriver {
  observe(): Promise<DesktopFrame>
  current(): Promise<{ windowID: string; location?: string }>
  perform(action: DesktopAction): Promise<void>
  cancel?(): void
}

type DesktopObservation = ComputerObservation & { target: ComputerTarget & { surface: "desktop" } }

export class DesktopSession {
  private readonly observations = new ObservationLedger("Desktop")
  private readonly listeners = new Set<(state: DesktopState) => void>()
  private state: DesktopState = { control: "agent", busy: false }
  private revision = 0
  private active = 0
  private queue = Promise.resolve()

  constructor(private readonly driver: DesktopDriver) {}

  current(): DesktopState {
    return { ...this.state }
  }

  onState(listener: (state: DesktopState) => void): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => this.listeners.delete(listener)
  }

  async observe(): Promise<DesktopFrame & { observation: DesktopObservation }> {
    const frame = await this.driver.observe()
    if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0)
      throw new Error("Desktop observation dimensions must be positive integers")
    if (!frame.windowID) throw new Error("Desktop observation requires an exact window identity")
    const observation = this.observations.issue(
      {
        surface: "desktop",
        windowID: frame.windowID,
        ...(frame.location ? { location: frame.location } : {}),
      },
      this.revision,
    )
    return { ...frame, observation }
  }

  execute(action: DesktopAction): Promise<void> {
    if (this.state.control === "manual")
      return Promise.reject(new Error("Resume agent desktop control before sending another action"))
    const run = async () => {
      const current = await this.driver.current()
      this.validate(action)
      if (action.windowID !== current.windowID)
        throw new Error("Desktop action targets a different window; no action was dispatched")
      this.observations.consume(
        action.observationID,
        {
          surface: "desktop",
          windowID: current.windowID,
          ...(current.location ? { location: current.location } : {}),
        },
        this.revision,
      )
      const revision = this.revision
      if (this.state.control === "manual" || revision !== this.revision)
        throw new Error("Desktop action cancelled for manual takeover; no action was dispatched")
      this.observations.invalidate("desktop", current.windowID)
      this.active += 1
      this.update({ control: "agent", busy: true })
      try {
        await this.driver.perform(action)
      } finally {
        this.active = Math.max(0, this.active - 1)
        if (this.state.control === "agent") this.update({ control: "agent", busy: this.active > 0 })
      }
    }
    const result = this.queue.then(run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  takeControl(reason = "You took manual control of the desktop."): void {
    this.revision += 1
    this.observations.invalidate("desktop")
    this.driver.cancel?.()
    this.update({ control: "manual", busy: this.active > 0, reason })
  }

  resume(): void {
    this.revision += 1
    this.observations.invalidate("desktop")
    this.update({ control: "agent", busy: this.active > 0 })
  }

  dispose(): void {
    this.takeControl("Desktop control stopped.")
    this.listeners.clear()
  }

  private validate(action: DesktopAction): void {
    if (!action.windowID) throw new Error("Desktop action requires an exact window identity")
    if (action.operation === "pointer") {
      if (![action.x, action.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
        throw new Error("Desktop pointer coordinates must be normalized values from 0 through 1")
      return
    }
    if (action.operation === "scroll") {
      if (![action.deltaX, action.deltaY].every(Number.isFinite))
        throw new Error("Desktop scroll deltas must be finite numbers")
      return
    }
    if (action.operation === "type" && action.text.length > 200_000)
      throw new Error("Desktop text input exceeds the 200,000 character limit")
    if (action.operation === "key" && (!action.key || action.key.length > 100))
      throw new Error("Desktop key identity must contain 1 through 100 characters")
  }

  private update(state: DesktopState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.current())
  }
}
