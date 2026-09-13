import type { KiloClient } from "@kilocode/sdk/v2/client"

type Scope = { client: KiloClient | null; directory: string; generation: number }
type Post = (message: Record<string, unknown>) => void

type Organization = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]

type Member = Organization["members"][number]
type Delegation = Organization["delegations"][number]

function member(value: unknown, position: number): value is Member {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Member>
  return (
    typeof item.agentID === "string" &&
    !!item.agentID &&
    typeof item.role === "string" &&
    !!item.role.trim() &&
    Number.isSafeInteger(item.position) &&
    item.position === position &&
    (item.supervisorID === undefined || typeof item.supervisorID === "string")
  )
}

function delegation(value: unknown, position: number, ids: ReadonlySet<string>): value is Delegation {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Delegation>
  return (
    typeof item.senderID === "string" &&
    typeof item.recipientID === "string" &&
    item.senderID !== item.recipientID &&
    ids.has(item.senderID) &&
    ids.has(item.recipientID) &&
    Number.isSafeInteger(item.position) &&
    item.position === position
  )
}

export function organization(value: unknown, archived = false): value is Organization {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Organization>
  if (item.version !== 1 || typeof item.id !== "string" || !/^org_[a-f0-9]{32}$/.test(item.id)) return false
  if (typeof item.name !== "string" || (item.purpose !== undefined && typeof item.purpose !== "string")) return false
  if (!Number.isSafeInteger(item.revision) || item.archived !== archived) return false
  if (
    !Number.isSafeInteger(item.createdAt) ||
    !Number.isSafeInteger(item.updatedAt) ||
    !Array.isArray(item.members) ||
    !Array.isArray(item.delegations)
  )
    return false
  const members = item.members
  if (members.length < 1 || !members.every(member)) return false
  const ids = new Set(members.map((entry) => entry.agentID))
  if (ids.size !== members.length) return false
  if (!members.every((entry) => !entry.supervisorID || ids.has(entry.supervisorID))) return false
  if (!item.delegations.every((entry, position) => delegation(entry, position, ids))) return false
  const edges = new Set(item.delegations.map((edge) => `${edge.senderID}\u0000${edge.recipientID}`))
  return edges.size === item.delegations.length
}

function organizations(value: unknown) {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) return
  if (!value.items.every((item) => organization(item))) return
  return value.items
}

async function groups(kilo: KiloClient["kilocode"]["routine"], directory: string, signal: AbortSignal) {
  return kilo.organization
    .list({ directory }, { throwOnError: true, signal })
    .then((result) => organizations(result.data))
    .catch(() => undefined)
}

async function histories(
  kilo: KiloClient["kilocode"]["routine"],
  agents: readonly { id: string }[],
  directory: string,
  options: { throwOnError: true; signal: AbortSignal },
  valid: () => boolean,
  post: Post,
) {
  const failed: string[] = []
  for (const item of agents) {
    if (!valid()) return
    if (options.signal.aborted) {
      failed.push(item.id)
      post({
        type: "routineRuns",
        agentID: item.id,
        error: "History refresh timed out. Previously loaded history is retained.",
      })
      continue
    }
    const runs = await kilo.runs({ directory, agentID: item.id }, options).catch(() => undefined)
    if (Array.isArray(runs?.data) && runs.data.every((run) => run.agentID === item.id)) {
      post({ type: "routineRuns", agentID: item.id, runs: runs.data })
      continue
    }
    failed.push(item.id)
    post({
      type: "routineRuns",
      agentID: item.id,
      error: "History could not be refreshed. Previously loaded history is retained.",
    })
  }
  return failed
}

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
      if (box.status === "fulfilled" && Array.isArray(box.value.data))
        post({ type: "routineInbox", items: box.value.data })
      else
        post({
          type: "routineInbox",
          error: "Inbox could not be refreshed. Previously loaded conversations are retained.",
        })
      const group = await groups(kilo, scope.directory, controller.signal)
      if (!valid()) return
      post(
        group
          ? { type: "routineState", organizations: group }
          : {
              type: "routineState",
              organizationError: "Organizations could not be refreshed. Previously loaded organizations are retained.",
            },
      )
      const failed = await histories(kilo, agents.data, scope.directory, options, valid, post)
      if (!failed) return
      post({ type: "routineState", refresh: failed.length || !group ? "partial" : "complete", failed })
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
