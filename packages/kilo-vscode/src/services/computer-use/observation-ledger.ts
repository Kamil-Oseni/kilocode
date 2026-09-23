import { randomUUID } from "node:crypto"

export type ComputerSurface = "browser" | "desktop" | "mobile"

export type ComputerTarget = {
  surface: ComputerSurface
  windowID: string
  documentID?: string
  location?: string
}

export type ComputerObservation = {
  version: 2
  id: string
  sequence: number
  sceneVersion: number
  observedAt: number
  validUntil: number
  target: ComputerTarget
}

type Record = { value: ComputerObservation; revision: number }
export type SceneStep = { id: string; observation: ComputerObservation }

export class ObservationLedger {
  private readonly records = new Map<string, Record>()
  private readonly steps = new Map<string, Record>()
  private sequence = 0

  constructor(
    private readonly label: string,
    private readonly ttl = 60_000,
    private readonly capacity = 256,
  ) {
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Computer observation lifetime must be positive")
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("Computer observation capacity must be positive")
  }

  issue<T extends ComputerTarget>(target: T, revision: number, now = Date.now()): ComputerObservation & { target: T } {
    return this.create(target, revision, 1, now, now + this.ttl)
  }

  begin(id: string, target: ComputerTarget, revision: number, now = Date.now()): SceneStep {
    const record = this.take(id, target, revision, now)
    const step = { id: randomUUID(), observation: record.value }
    this.steps.set(step.id, record)
    while (this.steps.size > this.capacity) this.steps.delete(this.steps.keys().next().value!)
    return step
  }

  advance<T extends ComputerTarget>(
    step: SceneStep,
    target: T,
    revision: number,
    now = Date.now(),
  ): ComputerObservation & { target: T } {
    const record = this.steps.get(step.id)
    this.steps.delete(step.id)
    if (!record || record.value.id !== step.observation.id)
      throw new Error(`${this.label} scene step is unknown or was already advanced; stop the action sequence`)
    if (record.revision !== revision)
      throw new Error(`${this.label} scene step became stale after manual control; stop the action sequence`)
    if (record.value.validUntil < now) throw new Error(`${this.label} scene continuity expired; take a fresh snapshot`)
    return this.create(target, revision, record.value.sceneVersion + 1, now, record.value.validUntil)
  }

  cancel(step: SceneStep): void {
    this.steps.delete(step.id)
  }

  private create<T extends ComputerTarget>(
    target: T,
    revision: number,
    sceneVersion: number,
    now: number,
    validUntil: number,
  ): ComputerObservation & { target: T } {
    const value: ComputerObservation & { target: T } = {
      version: 2,
      id: randomUUID(),
      sequence: ++this.sequence,
      sceneVersion,
      observedAt: now,
      validUntil,
      target,
    }
    this.records.set(value.id, { value, revision })
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value!)
    return value
  }

  consume(id: string, target: ComputerTarget, revision: number, now = Date.now()): ComputerObservation {
    return this.take(id, target, revision, now).value
  }

  private take(id: string, target: ComputerTarget, revision: number, now: number): Record {
    const record = this.records.get(id)
    this.records.delete(id)
    if (!record) throw new Error(`${this.label} observation is unknown or was already used; take a fresh snapshot`)
    if (record.value.validUntil < now) throw new Error(`${this.label} observation expired; take a fresh snapshot`)
    if (record.revision !== revision)
      throw new Error(`${this.label} observation became stale after manual control; take a fresh snapshot`)
    if (
      record.value.target.surface !== target.surface ||
      record.value.target.windowID !== target.windowID ||
      record.value.target.documentID !== target.documentID
    )
      throw new Error(`${this.label} observation belongs to a different window or document; no action was dispatched`)
    if (record.value.target.location !== target.location)
      throw new Error(`${this.label} observation became stale after navigation; take a fresh snapshot`)
    return record
  }

  invalidate(surface?: ComputerSurface, windowID?: string): void {
    for (const [id, record] of this.records) {
      if (surface && record.value.target.surface !== surface) continue
      if (windowID && record.value.target.windowID !== windowID) continue
      this.records.delete(id)
    }
    for (const [id, record] of this.steps) {
      if (surface && record.value.target.surface !== surface) continue
      if (windowID && record.value.target.windowID !== windowID) continue
      this.steps.delete(id)
    }
  }

  clear(): void {
    this.records.clear()
    this.steps.clear()
  }
}
