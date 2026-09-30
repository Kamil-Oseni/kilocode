import type { KiloClient, KilocodeRoutineEventsResponse } from "@kilocode/sdk/v2/client"

type Scope = { client: KiloClient | null; directory: string; generation: number }
type Event = KilocodeRoutineEventsResponse["events"][number]

function changed(value: unknown): value is Event {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Partial<Event>
  return (
    event.version === 1 &&
    event.kind === "run.changed" &&
    event.visibility === "workspace" &&
    typeof event.agentID === "string" &&
    !!event.agentID &&
    event.stream === event.agentID &&
    typeof event.runID === "string" &&
    typeof event.sessionID === "string" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence! > 0 &&
    event.id === `${event.agentID}:${event.sequence}` &&
    Number.isSafeInteger(event.stateRevision) &&
    event.stateRevision! > 0 &&
    typeof event.at === "number" &&
    Number.isFinite(event.at) &&
    ["running", "complete", "blocked", "error"].includes(event.status ?? "")
  )
}

function snapshot(page: KilocodeRoutineEventsResponse | undefined, id: string): page is KilocodeRoutineEventsResponse {
  return Boolean(
    page &&
      page.version === 1 &&
      Number.isSafeInteger(page.cursor) &&
      page.cursor >= 0 &&
      Array.isArray(page.runs) &&
      Array.isArray(page.events) &&
      page.runs.every((run) => run.agentID === id && Number.isFinite(run.at) && !!run.id) &&
      page.events.every((event) => changed(event) && event.agentID === id && event.sequence <= page.cursor),
  )
}

/** Replays routine changes from the durable cursor. SSE is only an invalidation hint. */
export class RoutineEvents {
  private scope?: Scope
  private readonly cursors = new Map<string, number>()
  private readonly known = new Set<string>()
  private readonly pending = new Set<string>()
  private readonly inflight = new Map<string, AbortController>()
  private readonly wanted = new Map<string, number>()
  private readonly lag = new Map<string, number>()
  private readonly failed = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private active?: Promise<void>
  private stopped = false
  private overflow = false
  private epoch = 0
  private deadline?: number

  constructor(
    private readonly current: () => Scope,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly timeout = 15_000,
  ) {}

  watch(ids: readonly string[]) {
    this.sync()
    this.known.clear()
    for (const id of ids.slice(0, 256)) if (id) this.known.add(id)
    if (ids.length > 256) this.warn()
    for (const id of this.cursors.keys()) if (!this.known.has(id)) this.cursors.delete(id)
    for (const id of this.wanted.keys()) if (!this.known.has(id)) this.wanted.delete(id)
    for (const id of this.lag.keys()) if (!this.known.has(id)) this.lag.delete(id)
    for (const id of this.failed) if (!this.known.has(id)) this.failed.delete(id)
    for (const id of this.pending) if (!this.known.has(id)) this.pending.delete(id)
  }

  hint(value: unknown): Promise<void> {
    if (!changed(value) || this.stopped) return Promise.resolve()
    this.sync()
    if (!this.known.has(value.agentID) && this.known.size >= 256) {
      this.warn()
      return Promise.resolve()
    }
    if (value.sequence <= (this.cursors.get(value.agentID) ?? 0)) return Promise.resolve()
    this.wanted.set(value.agentID, Math.max(value.sequence, this.wanted.get(value.agentID) ?? 0))
    this.enqueue(value.agentID)
    return this.active ?? Promise.resolve()
  }

  recover(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.sync()
    for (const id of this.known) this.pending.add(id)
    this.failed.clear()
    this.deadline = Date.now() + Math.min(30_000, this.timeout)
    this.start()
    return this.active ?? Promise.resolve()
  }

  invalidate() {
    this.epoch++
    this.pending.clear()
    this.inflight.clear()
    this.wanted.clear()
    this.lag.clear()
    this.failed.clear()
    this.deadline = undefined
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.active = undefined
  }

  dispose() {
    this.stopped = true
    this.invalidate()
    this.cursors.clear()
    this.known.clear()
  }

  private sync() {
    const scope = this.current()
    if (this.scope && this.scope.directory !== scope.directory) {
      this.invalidate()
      this.cursors.clear()
      this.known.clear()
      this.overflow = false
    }
    if (this.scope && (this.scope.client !== scope.client || this.scope.generation !== scope.generation)) {
      this.pending.clear()
      for (const controller of this.controllers) controller.abort()
      this.controllers.clear()
      this.inflight.clear()
    }
    this.scope = { ...scope }
  }

  private enqueue(id: string) {
    this.known.add(id)
    if (!this.inflight.has(id)) this.pending.add(id)
    this.start()
  }

  private start() {
    if (this.active || !this.pending.size || !this.scope?.client || this.stopped) return
    const epoch = this.epoch
    const active = this.drain(epoch).finally(() => {
      if (this.active !== active) return
      this.active = undefined
      if (this.deadline !== undefined && this.failed.size)
        this.post({
          type: "routineState",
          error: "Some live routine history could not be recovered. Refresh Routines to try again.",
        })
      this.failed.clear()
      this.deadline = undefined
      if (this.pending.size) this.start()
    })
    this.active = active
  }

  private async drain(epoch: number) {
    while (this.pending.size && !this.stopped && epoch === this.epoch) {
      if (this.deadline !== undefined && Date.now() >= this.deadline) {
        this.pending.clear()
        this.deadline = undefined
        this.failed.clear()
        this.post({ type: "routineState", error: "Live routine recovery timed out. Refresh Routines to try again." })
        return
      }
      const ids = [...this.pending].slice(0, 4)
      for (const id of ids) this.pending.delete(id)
      await Promise.all(ids.map((id) => this.read(id)))
    }
  }

  private async read(id: string) {
    const scope = this.scope
    if (!scope?.client) return
    const controller = new AbortController()
    this.inflight.set(id, controller)
    this.controllers.add(controller)
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(this.timeout, this.deadline === undefined ? this.timeout : this.deadline - Date.now())),
    )
    const valid = () => {
      const now = this.current()
      return (
        !this.stopped &&
        !controller.signal.aborted &&
        this.controllers.has(controller) &&
        now.client === scope.client &&
        now.directory === scope.directory &&
        now.generation === scope.generation
      )
    }
    const fetch = (after?: number) =>
      scope.client!.kilocode.routine.events(
        { directory: scope.directory, agentID: id, after: after === undefined ? undefined : String(after) },
        { throwOnError: true, signal: controller.signal },
      )
    try {
      const cursor = this.cursors.get(id)
      const result = await (cursor === undefined ? fetch() : fetch(cursor).catch(() => fetch()))
      if (!valid()) return
      const page = result.data
      if (!snapshot(page, id)) throw new Error("Invalid routine event snapshot")
      if (cursor !== undefined && page.cursor < cursor) throw new Error("Regressive routine event cursor")
      if (cursor !== undefined && page.cursor === cursor && !this.wanted.has(id)) return
      this.cursors.set(id, page.cursor)
      this.failed.delete(id)
      this.post({ type: "routineRuns", agentID: id, runs: page.runs, cursor: page.cursor })
      const wanted = this.wanted.get(id) ?? 0
      this.wanted.delete(id)
      if (wanted > page.cursor) {
        const lag = (this.lag.get(id) ?? 0) + 1
        if (lag < 3) {
          this.lag.set(id, lag)
          this.pending.add(id)
        } else {
          this.lag.delete(id)
          this.post({ type: "routineRuns", agentID: id, error: "Routine updates are delayed. Refresh to recover." })
        }
      } else this.lag.delete(id)
    } catch {
      // A later live event or reconnect replays from the same durable cursor.
      if (this.deadline !== undefined) this.failed.add(id)
    } finally {
      clearTimeout(timer)
      controller.abort()
      this.controllers.delete(controller)
      if (this.inflight.get(id) === controller) this.inflight.delete(id)
    }
  }

  private warn() {
    if (this.overflow) return
    this.overflow = true
    this.post({
      type: "routineState",
      error: "Too many workers for live updates. Refresh Routines to load current history.",
    })
  }
}
