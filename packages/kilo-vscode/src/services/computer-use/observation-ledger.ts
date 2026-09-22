import { randomUUID } from "node:crypto"

export type ComputerSurface = "browser" | "desktop" | "mobile"

export type ComputerTarget = {
  surface: ComputerSurface
  windowID: string
  documentID?: string
  location?: string
}

export type ComputerObservation = {
  version: 1
  id: string
  observedAt: number
  validUntil: number
  target: ComputerTarget
}

type Record = { value: ComputerObservation; revision: number }

export class ObservationLedger {
  private readonly records = new Map<string, Record>()

  constructor(
    private readonly label: string,
    private readonly ttl = 60_000,
    private readonly capacity = 256,
  ) {
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Computer observation lifetime must be positive")
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("Computer observation capacity must be positive")
  }

  issue<T extends ComputerTarget>(target: T, revision: number, now = Date.now()): ComputerObservation & { target: T } {
    const value: ComputerObservation & { target: T } = {
      version: 1,
      id: randomUUID(),
      observedAt: now,
      validUntil: now + this.ttl,
      target,
    }
    this.records.set(value.id, { value, revision })
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value!)
    return value
  }

  consume(id: string, target: ComputerTarget, revision: number, now = Date.now()): ComputerObservation {
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
    return record.value
  }

  invalidate(surface?: ComputerSurface, windowID?: string): void {
    for (const [id, record] of this.records) {
      if (surface && record.value.target.surface !== surface) continue
      if (windowID && record.value.target.windowID !== windowID) continue
      this.records.delete(id)
    }
  }

  clear(): void {
    this.records.clear()
  }
}
