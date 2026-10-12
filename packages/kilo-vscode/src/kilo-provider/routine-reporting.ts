import type { KiloClient } from "@kilocode/sdk/v2/client"
import { Reports } from "../shared/routine-reports"
import { sameDirectory } from "../kilo-provider-utils"

export async function reports(
  config: { baseUrl: string; password: string },
  directory: string,
  sessionID: string,
  signal: AbortSignal,
) {
  const url = new URL("/kilocode/agent-reports", config.baseUrl)
  url.searchParams.set("sessionID", sessionID)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`kilo:${config.password}`).toString("base64")}` },
    redirect: "error",
    signal,
  })
  if (!response.ok) throw new Error("Original report snapshot unavailable")
  return Reports.parse(await response.json())
}

type Scope = { client: KiloClient | null; directory: string; generation: number; sessionID?: string }
type Report = { id: string; reportSessionID: string; revision: number; directory: string }
type Request = { requestID: string; sessionID: string }

function snapshot<T extends Report>(
  items: readonly T[],
  session: string,
  directory: string,
  revisions: Map<string, number>,
) {
  if (!Array.isArray(items) || items.length > 200) throw new Error("Bounded report snapshot required")
  const seen = new Set<string>()
  for (const item of items) {
    if (
      !item.id ||
      seen.has(item.id) ||
      item.reportSessionID !== session ||
      !sameDirectory(item.directory, directory) ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      item.revision < (revisions.get(item.id) ?? 0)
    )
      throw new Error("Original report identity or revision changed")
    seen.add(item.id)
  }
}

/** Backend report cards are authoritative; reconnect reloads never synthesize notices or message writes. */
export class RoutineReporting<T extends Report> {
  private request?: Request
  private controller?: AbortController
  private active?: Promise<void>
  private queued = false
  private stopped = false
  private readonly revisions = new Map<string, number>()

  constructor(
    private readonly current: () => Scope,
    private readonly read: (
      client: KiloClient,
      directory: string,
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<readonly T[]>,
    private readonly post: (message: {
      type: "agentReportsLoaded"
      requestID: string
      sessionID: string
      items?: readonly T[]
      error?: string
    }) => void,
    private readonly timeout = 15_000,
  ) {}

  load(request: Request): Promise<void> {
    if (this.stopped || !request.requestID || !request.sessionID) return Promise.resolve()
    if (this.request?.sessionID !== request.sessionID) this.revisions.clear()
    this.controller?.abort()
    this.request = { ...request }
    this.queued = true
    return this.start()
  }

  hint(): Promise<void> {
    if (this.stopped || !this.request) return Promise.resolve()
    this.queued = true
    return this.start()
  }

  invalidate() {
    this.controller?.abort()
    this.request = undefined
    this.queued = false
    this.revisions.clear()
  }

  dispose() {
    this.stopped = true
    this.invalidate()
  }

  private start(): Promise<void> {
    if (this.active) return this.active
    const active = this.drain().finally(() => {
      if (this.active !== active) return
      this.active = undefined
      if (this.queued && !this.stopped) return this.start()
    })
    this.active = active
    return active
  }

  private async drain() {
    while (this.queued && !this.stopped) {
      this.queued = false
      await this.fetch()
    }
  }

  private async fetch() {
    const request = this.request
    const scope = this.current()
    if (!request || !scope.client || scope.sessionID !== request.sessionID) return
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => controller.abort(), this.timeout)
    const owned = () => {
      const now = this.current()
      return (
        !this.stopped &&
        this.request === request &&
        now.client === scope.client &&
        now.directory === scope.directory &&
        now.generation === scope.generation &&
        now.sessionID === request.sessionID
      )
    }
    try {
      const items = await this.read(scope.client, scope.directory, request.sessionID, controller.signal)
      if (!owned() || controller.signal.aborted) return
      snapshot(items, request.sessionID, scope.directory, this.revisions)
      for (const item of items) this.revisions.set(item.id, item.revision)
      this.post({ type: "agentReportsLoaded", ...request, items })
    } catch {
      if (!owned()) return
      this.post({
        type: "agentReportsLoaded",
        ...request,
        error: "Routine reports could not be refreshed. Previously loaded cards are retained; retry when connected.",
      })
    } finally {
      clearTimeout(timer)
      if (this.controller === controller) this.controller = undefined
    }
  }
}
