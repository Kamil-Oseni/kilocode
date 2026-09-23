import { createHash } from "node:crypto"
import { ObservationLedger, type ComputerObservation, type ComputerTarget } from "./observation-ledger"
import type { SensitiveCategory } from "./lease-store"
import { mismatch } from "./desktop-sensitive"
import { DesktopFrameRing } from "./desktop-frame-ring"
import {
  executeSequence,
  type DesktopPlannedAction,
  type DesktopScene,
  type DesktopSequenceInput,
  type DesktopSequenceResult,
} from "./desktop-sequence"

export const CAPTURE = { edge: 4_096, pixels: 8_294_400, bytes: 15_000_000, data: 20_000_000 } as const

export type DesktopControl = {
  controlID: string
  role: string
  name?: string
  automationID?: string
  x: number
  y: number
  width: number
  height: number
  enabled: boolean
  focused: boolean
  selected?: boolean
  actions: ("invoke" | "select" | "toggle" | "expand_collapse" | "value" | "scroll")[]
}

export type DesktopSemantics = {
  source: "windows_ui_automation"
  status: "available" | "unavailable"
  viewport: { x: number; y: number; width: number; height: number }
  controls: DesktopControl[]
  truncated: boolean
}

export type DesktopFrame = {
  windowID: string
  location?: string
  width: number
  height: number
  mime: "image/png" | "image/jpeg"
  data: string
  semantics?: DesktopSemantics
  timing: {
    acquisitionMs: number
    preparationMs: number
    semanticsMs?: number
    totalMs: number
  }
}

export type DesktopWindow = {
  windowID: string
  location: string
  title: string
  processID: number
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  foreground: boolean
}

export type DesktopAction = {
  windowID: string
  observationID: string
  sensitive: SensitiveCategory | false
} & (
  | { operation: "pointer"; action: "move" | "click" | "double_click"; x: number; y: number; button?: "left" | "right" }
  | {
      operation: "drag"
      startX: number
      startY: number
      endX: number
      endY: number
      button: "left" | "right"
    }
  | { operation: "type"; text: string }
  | { operation: "key"; key: string; modifiers?: readonly ("alt" | "control" | "meta" | "shift")[] }
  | { operation: "scroll"; deltaX: number; deltaY: number }
)

export type DesktopState = {
  control: "agent" | "manual"
  busy: boolean
  reason?: string
}

export class DesktopOutcomeError extends Error {
  readonly name = "DesktopOutcomeError"

  constructor(operation: string, detail: string) {
    super(
      `The desktop ${operation} may have taken effect. It was not retried. Inspect the target before repeating it. ${detail}`,
    )
  }
}

export interface DesktopDriver {
  observe(): Promise<DesktopFrame>
  windows(): Promise<DesktopWindow[]>
  current(): Promise<{ windowID: string; location?: string }>
  focus(target: DesktopWindow): Promise<void>
  perform(action: DesktopAction, target: { windowID: string; location?: string }): Promise<void>
  cancel?(): void
}

type DesktopObservation = ComputerObservation & { target: ComputerTarget & { surface: "desktop" } }

export class DesktopSession {
  private readonly observations = new ObservationLedger("Desktop")
  private readonly semantics = new Map<string, DesktopSemantics>()
  private readonly frames = new DesktopFrameRing<DesktopScene>()
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
    const frame = await this.capture()
    const observation = this.observations.issue(this.target(frame), this.revision)
    const scene = { ...frame, observation }
    this.retain(scene)
    return scene
  }

  private async capture(): Promise<DesktopFrame> {
    const frame = await this.driver.observe()
    if (
      !Number.isInteger(frame.width) ||
      frame.width <= 0 ||
      !Number.isInteger(frame.height) ||
      frame.height <= 0 ||
      frame.width > CAPTURE.edge ||
      frame.height > CAPTURE.edge ||
      frame.width * frame.height > CAPTURE.pixels
    )
      throw new Error("Desktop observation dimensions exceed the safe capture bounds")
    if (
      (frame.mime !== "image/png" && frame.mime !== "image/jpeg") ||
      typeof frame.data !== "string" ||
      !frame.data ||
      frame.data.length > CAPTURE.data
    )
      throw new Error("Desktop observation exceeds the encoded image limit")
    if (!frame.windowID) throw new Error("Desktop observation requires an exact window identity")
    if (
      ![
        frame.timing.acquisitionMs,
        frame.timing.preparationMs,
        ...(frame.timing.semanticsMs === undefined ? [] : [frame.timing.semanticsMs]),
        frame.timing.totalMs,
      ].every((value) => Number.isFinite(value) && value >= 0 && value <= 120_000) ||
      frame.timing.totalMs < frame.timing.acquisitionMs + frame.timing.preparationMs + (frame.timing.semanticsMs ?? 0)
    )
      throw new Error("Desktop observation timing is invalid")
    return frame
  }

  async windows(): Promise<{ windows: DesktopWindow[]; observation: DesktopObservation }> {
    const windows = await this.driver.windows()
    this.validateWindows(windows)
    const observation = this.observations.issue(this.catalog(windows), this.revision)
    return { windows, observation }
  }

  focus(windowID: string, observationID: string): Promise<void> {
    if (this.state.control === "manual")
      return Promise.reject(new Error("Resume agent desktop control before switching windows"))
    const run = async () => {
      const windows = await this.driver.windows()
      this.validateWindows(windows)
      const target = windows.find((window) => window.windowID === windowID)
      if (!target) throw new Error("The selected desktop window is no longer available; list windows again")
      this.observations.consume(observationID, this.catalog(windows), this.revision)
      const revision = this.revision
      if (this.state.control === "manual" || revision !== this.revision)
        throw new Error("Desktop window switch cancelled for manual takeover; no action was dispatched")
      this.observations.invalidate("desktop")
      this.semantics.clear()
      this.frames.clear()
      this.active += 1
      this.update({ control: "agent", busy: true })
      try {
        await this.driver.focus(target).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          throw new DesktopOutcomeError("window switch", detail)
        })
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

  execute(action: DesktopAction): Promise<void> {
    if (this.state.control === "manual")
      return Promise.reject(new Error("Resume agent desktop control before sending another action"))
    const run = async () => {
      const current = await this.driver.current()
      this.validate(action)
      if (action.windowID !== current.windowID)
        throw new Error("Desktop action targets a different window; no action was dispatched")
      const semantic = this.semantics.get(action.observationID)
      this.semantics.delete(action.observationID)
      this.frames.delete(action.observationID)
      this.observations.consume(
        action.observationID,
        {
          surface: "desktop",
          windowID: current.windowID,
          ...(current.location ? { location: current.location } : {}),
        },
        this.revision,
      )
      const reason = mismatch(action, semantic)
      if (reason) throw new Error(reason)
      const revision = this.revision
      if (this.state.control === "manual" || revision !== this.revision)
        throw new Error("Desktop action cancelled for manual takeover; no action was dispatched")
      this.observations.invalidate("desktop", current.windowID)
      this.semantics.clear()
      this.frames.clear()
      this.active += 1
      this.update({ control: "agent", busy: true })
      try {
        await this.driver.perform(action, current).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          throw new DesktopOutcomeError(action.operation, detail)
        })
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

  sequence(
    input: Omit<DesktopSequenceInput, "scene"> & { observationID: string },
    authorize?: (action: DesktopPlannedAction) => void | Promise<void>,
  ): Promise<DesktopSequenceResult> {
    if (this.state.control === "manual")
      return Promise.reject(new Error("Resume agent desktop control before sending an action sequence"))
    const run = async () => {
      const scene = this.frames.get(input.observationID)
      if (!scene) throw new Error("Desktop sequence requires a retained fresh observation")
      const revision = this.revision
      let effects = 0
      this.active += 1
      this.update({ control: "agent", busy: true })
      try {
        return await executeSequence(
          { scene, steps: input.steps, maxDurationMs: input.maxDurationMs },
          {
            step: async (planned, before) => {
              const current = await this.driver.current()
              const action = { ...planned, observationID: before.observation.id } as DesktopAction
              this.validate(action)
              if (
                current.windowID !== before.observation.target.windowID ||
                current.location !== before.observation.target.location
              )
                throw new Error("Desktop sequence scene changed before dispatch; no action was sent")
              const reason = mismatch(action, before.semantics)
              if (reason) throw new Error(reason)
              await authorize?.(planned)
              const token = this.observations.begin(before.observation.id, before.observation.target, revision)
              this.frames.delete(before.observation.id)
              this.semantics.delete(before.observation.id)
              this.observations.invalidate("desktop", current.windowID, token.id)
              if (this.state.control === "manual" || revision !== this.revision) {
                this.observations.cancel(token)
                throw new Error("Desktop sequence cancelled for manual takeover; no action was dispatched")
              }
              await this.driver.perform(action, current).catch((error: unknown) => {
                this.observations.cancel(token)
                const detail = error instanceof Error ? error.message : String(error)
                throw new DesktopOutcomeError(action.operation, detail)
              })
              effects += 1
              const frame = await this.capture().catch((error: unknown) => {
                this.observations.cancel(token)
                const detail = error instanceof Error ? error.message : String(error)
                throw new DesktopOutcomeError("sequence postcondition", detail)
              })
              const observation = (() => {
                try {
                  return this.observations.advance(token, this.target(frame), revision)
                } catch (error) {
                  const detail = error instanceof Error ? error.message : String(error)
                  throw new DesktopOutcomeError("sequence continuity", detail)
                }
              })()
              const next = { ...frame, observation }
              this.retain(next)
              return next
            },
            cancelled: () => this.state.control === "manual" || revision !== this.revision,
            now: () => performance.now(),
          },
        )
      } catch (error) {
        if (effects === 0 || error instanceof DesktopOutcomeError) throw error
        const detail = error instanceof Error ? error.message : String(error)
        throw new DesktopOutcomeError("partial sequence", detail)
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
    this.semantics.clear()
    this.frames.clear()
    this.driver.cancel?.()
    this.update({ control: "manual", busy: this.active > 0, reason })
  }

  resume(): void {
    this.revision += 1
    this.observations.invalidate("desktop")
    this.semantics.clear()
    this.frames.clear()
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
    if (action.operation === "drag") {
      if (
        ![action.startX, action.startY, action.endX, action.endY].every(
          (value) => Number.isFinite(value) && value >= 0 && value <= 1,
        )
      )
        throw new Error("Desktop drag coordinates must be normalized values from 0 through 1")
      if (action.startX === action.endX && action.startY === action.endY)
        throw new Error("Desktop drag requires different start and end points")
      return
    }
    if (action.operation === "scroll") {
      if (![action.deltaX, action.deltaY].every((value) => Number.isFinite(value) && value >= -1_200 && value <= 1_200))
        throw new Error("Desktop scroll deltas must be finite values from -1200 through 1200")
      if (action.deltaX === 0 && action.deltaY === 0) throw new Error("Desktop scroll requires non-zero movement")
      return
    }
    if (action.operation === "type" && action.text.length > 200_000)
      throw new Error("Desktop text input exceeds the 200,000 character limit")
    if (action.operation === "key" && (!action.key || action.key.length > 100))
      throw new Error("Desktop key identity must contain 1 through 100 characters")
  }

  private validateWindows(windows: DesktopWindow[]): void {
    if (windows.length > 64) throw new Error("Desktop window list exceeds the 64-window limit")
    const ids = new Set<string>()
    for (const window of windows) {
      if (!window.windowID || !window.location || !window.title || ids.has(window.windowID))
        throw new Error("Desktop window list contains an invalid or duplicate identity")
      if (
        !Number.isInteger(window.processID) ||
        window.processID < 0 ||
        ![window.x, window.y, window.width, window.height].every(Number.isInteger) ||
        window.width <= 0 ||
        window.height <= 0
      )
        throw new Error("Desktop window list contains invalid process or bounds metadata")
      ids.add(window.windowID)
    }
  }

  private retain(scene: DesktopScene): void {
    this.frames.set(scene)
    if (!scene.semantics) return
    this.semantics.set(scene.observation.id, scene.semantics)
    while (this.semantics.size > 256) this.semantics.delete(this.semantics.keys().next().value!)
  }

  private target(frame: DesktopFrame): ComputerTarget & { surface: "desktop" } {
    return {
      surface: "desktop",
      windowID: frame.windowID,
      ...(frame.location ? { location: frame.location } : {}),
    }
  }

  private catalog(windows: DesktopWindow[]): ComputerTarget & { surface: "desktop" } {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          [...windows]
            .sort((left, right) => left.windowID.localeCompare(right.windowID))
            .map((window) => [
              window.windowID,
              window.location,
              window.title,
              window.processID,
              window.x,
              window.y,
              window.width,
              window.height,
              window.minimized,
              window.foreground,
            ]),
        ),
      )
      .digest("hex")
    return { surface: "desktop", windowID: "visible-windows", location: fingerprint }
  }

  private update(state: DesktopState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.current())
  }
}
