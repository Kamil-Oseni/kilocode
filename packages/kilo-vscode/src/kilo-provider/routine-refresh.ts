import type { KiloClient } from "@kilocode/sdk/v2/client"

type Scope = { client: KiloClient | null; directory: string; generation: number }
type Post = (message: Record<string, unknown>) => void

/** One active read and one coalesced invalidation per provider. Never owns mutations. */
export class RoutineRefresh {
  private active?: Promise<void>
  private pending = false
  private stopped = false
  private controller?: AbortController
  private scope?: Scope
  private viewID?: string
  private readonly requests = new Set<string>()
  private sequence = 0

  constructor(
    private readonly current: () => Scope,
    private readonly post: Post,
    private readonly timeout = 30_000,
  ) {}

  request(requestID?: string, viewID?: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const scope = this.current()
    if (this.scope && !this.matches(this.scope, scope)) {
      this.controller?.abort()
      this.controller = undefined
      this.scope = undefined
      this.requests.clear()
    }
    if (viewID !== undefined) this.viewID = viewID
    const id = requestID ?? this.viewID ?? ""
    if (!this.requests.has(id) && this.requests.size >= 32) {
      this.post({
        type: "routineState",
        requestID,
        error: "Too many refresh requests. Retry after the current refresh.",
      })
      return Promise.resolve()
    }
    this.requests.add(id)
    this.pending = true
    if (this.active) return this.active
    this.active = this.drain().finally(() => {
      this.active = undefined
    })
    return this.active
  }

  invalidate() {
    this.pending = false
    this.viewID = undefined
    this.requests.clear()
    this.controller?.abort()
    this.controller = undefined
    this.scope = undefined
  }

  dispose() {
    this.stopped = true
    this.invalidate()
  }

  private async drain() {
    while (this.pending && !this.stopped) {
      this.pending = false
      await this.read()
    }
  }

  private matches(left: Scope, right: Scope) {
    return left.client === right.client && left.directory === right.directory && left.generation === right.generation
  }

  private async read() {
    const scope = { ...this.current() }
    this.scope = scope
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => controller.abort(), this.timeout)
    const refreshID = ++this.sequence
    const requests = [...new Set([...this.requests, ...(this.viewID ? [this.viewID] : [])])]
    this.requests.clear()
    const viewID = this.viewID
    const valid = () => {
      const current = this.current()
      return !this.stopped && this.matches(current, scope) && this.controller === controller
    }
    const post = (message: Record<string, unknown>) => {
      if (!valid()) return
      for (const requestID of requests) this.post({ ...message, requestID: requestID || undefined, viewID, refreshID })
    }
    const options = { throwOnError: true as const, signal: controller.signal }
    try {
      post({ type: "routineState", refresh: "loading" })
      if (!scope.client) throw new Error("Disconnected")
      const kilo = scope.client.kilocode.routine
      const results = await Promise.allSettled([
        kilo.list({ directory: scope.directory }, options),
        kilo.templates({ directory: scope.directory }, options),
        kilo.inbox({ directory: scope.directory }, options),
      ])
      if (!valid()) return
      if (controller.signal.aborted) throw new Error("Refresh deadline exceeded")
      const [roster, catalog, box] = results
      if (roster.status === "rejected" || catalog.status === "rejected") throw new Error("Roster unavailable")
      const agents = roster.value
      const templates = catalog.value
      if (!Array.isArray(agents.data) || !Array.isArray(templates.data)) throw new Error("Invalid roster")
      post({ type: "routineState", agents: agents.data, templates: templates.data })
      if (box.status === "fulfilled" && Array.isArray(box.value.data)) post({ type: "routineInbox", items: box.value.data })
      else
        post({
          type: "routineInbox",
          error: "Inbox could not be refreshed. Previously loaded conversations are retained.",
        })
      const failed: string[] = []
      for (const item of agents.data) {
        if (!valid()) return
        if (controller.signal.aborted) {
          failed.push(item.id)
          post({
            type: "routineRuns",
            agentID: item.id,
            error: "History refresh timed out. Previously loaded history is retained.",
          })
          continue
        }
        try {
          const runs = await kilo.runs({ directory: scope.directory, agentID: item.id }, options)
          if (!Array.isArray(runs.data) || runs.data.some((run) => run.agentID !== item.id))
            throw new Error("Invalid history")
          post({ type: "routineRuns", agentID: item.id, runs: runs.data })
        } catch {
          failed.push(item.id)
          post({
            type: "routineRuns",
            agentID: item.id,
            error: "History could not be refreshed. Previously loaded history is retained.",
          })
        }
      }
      post({ type: "routineState", refresh: failed.length ? "partial" : "complete", failed })
    } catch {
      post({
        type: "routineState",
        refresh: "error",
        error: "Routines could not be refreshed. Previously loaded information is retained. Retry when connected.",
      })
    } finally {
      clearTimeout(timer)
      controller.abort()
      if (this.controller === controller) this.controller = undefined
    }
  }
}
