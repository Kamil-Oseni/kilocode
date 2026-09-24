import { randomUUID } from "node:crypto"
import type { BrowserRequest, BrowserResult, DesktopRequest, DesktopResult } from "@kilocode/sdk/v2/client"

export type AuthorizationRequest =
  | Extract<DesktopRequest, { operation: "authorize" }>
  | Extract<BrowserRequest, { operation: "authorize" }>
export type Authorization =
  | Extract<DesktopResult, { operation: "authorize" }>
  | Extract<BrowserResult, { operation: "authorize" }>
export type ControlLevel = "observe" | "assisted" | "autonomous"
export type LeaseAction = AuthorizationRequest["action"]
export type SensitiveCategory = Exclude<AuthorizationRequest["sensitive"], boolean>
export type SensitiveRule = "allow_session" | "allow_always" | "ask" | "deny"
export type SensitivePolicy = Record<SensitiveCategory, SensitiveRule>

type Scope = { kind: "all" } | { kind: "selected"; values: string[]; identity?: string }
type Lifetime = { kind: "session"; sessionID: string } | { kind: "all_sessions" }
type Expiry = { kind: "until_stopped" } | { kind: "expires_at"; expiresAt: number }

export type ComputerUseLease = {
  version: 2
  id: string
  level: ControlLevel
  state: "active" | "paused" | "revoked"
  issuedAt: number
  lifetime: Lifetime
  expiry: Expiry
  applications: Scope
  monitors: Scope
  surfaces: ("browser" | "desktop" | "mobile")[]
  actions: LeaseAction[]
  sensitive: SensitivePolicy
  sensitiveSessionID: string
  cooperativeInput: boolean
}

export type GrantInput = {
  sessionID: string
  level: ControlLevel
  duration: "session" | "hour" | "until_stopped"
  applications: "all" | "current"
  windowID?: string
  identity?: string
  actions: LeaseAction[]
  sensitive: SensitivePolicy
  cooperativeInput: boolean
}

export interface LeaseStorage {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

export interface LeaseRevocations {
  has(id: string): boolean
  add(id: string): Promise<void>
}

const key = "raya.computerUse.lease.v1"
const actions = new Set<LeaseAction>([
  "observe",
  "pointer",
  "keyboard",
  "scroll",
  "window",
  "launch",
  "browser",
  "files",
])
const surfaces = new Set(["browser", "desktop", "mobile"])
export const categories = [
  "communications",
  "financial",
  "credentials",
  "software",
  "system",
  "deletion",
  "disclosure",
  "legal",
  "publishing",
] as const satisfies readonly SensitiveCategory[]
const rules = new Set<SensitiveRule>(["allow_session", "allow_always", "ask", "deny"])

export class ComputerUseLeaseStore {
  private lease: ComputerUseLease | undefined
  private readonly listeners = new Set<(lease: ComputerUseLease | undefined) => void>()
  private readonly sessions = new Set<string>()
  private readonly revoked = new Set<string>()
  private writes = Promise.resolve()
  private revision = 0
  private pending: { id: string; revision: number; sessionID: string; durable: boolean } | undefined

  constructor(
    private readonly storage: LeaseStorage,
    private readonly now = () => Date.now(),
    private readonly revocations?: LeaseRevocations,
    private readonly unavailable?: string,
  ) {
    if (unavailable) return
    this.lease = decode(storage.get<unknown>(key))
    if (
      this.lease &&
      (this.lease.lifetime.kind === "session" ||
        expired(this.lease, this.now()) ||
        this.revocations?.has(this.lease.id))
    )
      this.lease = undefined
  }

  current(): ComputerUseLease | undefined {
    return this.lease ? structuredClone(this.lease) : undefined
  }

  onChange(listener: (lease: ComputerUseLease | undefined) => void): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => this.listeners.delete(listener)
  }

  async grant(input: GrantInput): Promise<ComputerUseLease> {
    if (this.unavailable) throw new Error(this.unavailable)
    check(input)
    const policy = decodePolicy(input.sensitive)
    if (!policy) throw new Error("Choose a policy for every sensitive action category")
    checkSelection(input)
    const unique = [...new Set(input.actions)]
    if (unique.length === 0 || unique.length > 8 || unique.some((action) => !actions.has(action)))
      throw new Error("Choose at least one valid Computer Use action category")
    if (input.level === "observe" && unique.some((action) => action !== "observe"))
      throw new Error("Observe only may authorize observation, not input")
    const now = this.now()
    const lease: ComputerUseLease = {
      version: 2,
      id: randomUUID(),
      level: input.level,
      state: "active",
      issuedAt: now,
      lifetime:
        input.duration === "session" ? { kind: "session", sessionID: input.sessionID } : { kind: "all_sessions" },
      expiry:
        input.duration === "hour" ? { kind: "expires_at", expiresAt: now + 60 * 60 * 1000 } : { kind: "until_stopped" },
      applications:
        input.applications === "all"
          ? { kind: "all" }
          : { kind: "selected", values: [input.windowID!], identity: input.identity! },
      monitors: { kind: "all" },
      surfaces: ["browser", "desktop"],
      actions: unique,
      sensitive: policy,
      sensitiveSessionID: input.sessionID,
      cooperativeInput: input.cooperativeInput,
    }
    const revision = ++this.revision
    this.pending = {
      id: lease.id,
      revision,
      sessionID: input.sessionID,
      durable: lease.lifetime.kind === "all_sessions",
    }
    try {
      await this.persist(lease)
      if (this.revision !== revision) throw new Error("Computer Use grant changed before persistence completed")
      this.lease = lease
      this.revoked.delete(input.sessionID)
      this.emit()
      return this.current()!
    } finally {
      if (this.pending?.revision === revision) this.pending = undefined
    }
  }

  async pause(): Promise<void> {
    if (!this.pending && (!this.lease || this.lease.state !== "active")) return
    ++this.revision
    if (this.lease?.state === "active") this.lease = { ...this.lease, state: "paused" }
    this.pending = undefined
    this.emit()
    await this.persist()
  }

  async resume(): Promise<void> {
    if (!this.lease || this.lease.state !== "paused") return
    if (expired(this.lease, this.now())) {
      await this.stop()
      return
    }
    ++this.revision
    this.lease = { ...this.lease, state: "active" }
    await this.persist()
    this.emit()
  }

  async stop(): Promise<void> {
    if (!this.lease && !this.pending) return
    const ids = [
      this.lease?.lifetime.kind === "all_sessions" ? this.lease.id : undefined,
      this.pending?.durable ? this.pending.id : undefined,
    ].filter((id): id is string => !!id)
    ++this.revision
    if (this.lease) this.revoked.add(this.lease.sensitiveSessionID)
    if (this.pending) this.revoked.add(this.pending.sessionID)
    this.pending = undefined
    for (const session of this.sessions) this.revoked.add(session)
    this.sessions.clear()
    this.lease = undefined
    this.emit()
    const saved = this.persist()
    const revocations = this.revocations
    if (!revocations || ids.length === 0) {
      await saved
      return
    }
    const marked = (async () => {
      for (const id of ids) await revocations.add(id)
    })()
    const results = await Promise.allSettled([saved, marked])
    if (results.some((result) => result.status === "fulfilled")) return
    throw new Error("Desktop control stopped locally, but neither revocation store confirmed the Stop")
  }

  authorize(request: AuthorizationRequest): Authorization {
    const delegation = "delegation" in request ? request.delegation : undefined
    if (this.unavailable) return answer("deny", this.unavailable)
    const lease = this.lease
    if (!lease) return missing(request.sessionID, !!delegation, this.revoked)
    if (lease.state === "paused") return answer("deny", "Computer Use is paused")
    if (lease.state === "revoked") return answer("deny", "The Computer Use grant was revoked")
    if (expired(lease, this.now())) {
      void this.stop()
      return answer("deny", "The Computer Use grant expired")
    }
    if (delegation && mismatch(lease, request.sessionID, delegation))
      return answer("deny", "Computer Use child delegation no longer matches the active grant")
    if (invalidAdmission(request))
      return answer("deny", "Computer Use child admission is only for a parent's ordinary desktop observation grant")
    if (!delegation && lease.lifetime.kind === "session" && lease.lifetime.sessionID !== request.sessionID)
      return answer("ask", "The grant belongs to another task")
    const boundary = scope(lease, request)
    if (boundary) return limited(boundary, !!delegation)
    const policy = sensitive(lease, request, delegation?.parentSessionID)
    if (policy)
      return selectedResult(lease, delegation && policy.decision === "ask" ? { ...policy, grantID: lease.id } : policy)
    const result =
      selectedAdmission(lease, request) ?? answer("allow", "Authorized by active Computer Use grant", lease.id)
    if (result.decision === "allow") this.sessions.add(request.sessionID)
    return selectedResult(lease, result)
  }

  review(request: AuthorizationRequest): Authorization {
    if (!this.lease && !("delegation" in request && request.delegation)) this.revoked.delete(request.sessionID)
    return this.authorize(request)
  }

  private persist(lease = this.lease): Promise<void> {
    const value = lease?.lifetime.kind === "all_sessions" ? lease : undefined
    this.writes = this.writes.catch(() => undefined).then(() => Promise.resolve(this.storage.update(key, value)))
    return this.writes
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current())
  }
}

function scope(lease: ComputerUseLease, request: AuthorizationRequest): Authorization | undefined {
  if (!lease.surfaces.includes(request.surface)) return answer("ask", "This surface is outside the grant")
  if (lease.applications.kind === "selected" && request.surface !== "desktop")
    return answer("deny", "Selected window grants apply only to this desktop window")
  const admission = "admission" in request && request.admission === "computer_child"
  const delegation = "delegation" in request ? request.delegation : undefined
  const window =
    request.windowID ??
    delegation?.windowID ??
    (request.surface === "desktop" && request.action === "observe" && lease.applications.kind === "selected"
      ? lease.applications.values[0]
      : undefined)
  if (lease.applications.kind === "selected" && !admission && (!window || !lease.applications.values.includes(window)))
    return answer("deny", "This application is outside the selected grant")
  if (lease.level === "observe" && request.action !== "observe")
    return answer("deny", "Observe only cannot control the desktop")
  if (!lease.actions.includes(request.action)) return answer("ask", "This action is outside the grant")
}

function missing(session: string, delegation: boolean, revoked: Set<string>): Authorization {
  return delegation || revoked.has(session)
    ? answer("deny", "Computer Use was stopped for this task")
    : answer("ask", "No active Computer Use grant")
}

function limited(result: Authorization, delegation: boolean): Authorization {
  return delegation && result.decision === "ask" ? { ...result, decision: "deny" } : result
}

function selectedResult(lease: ComputerUseLease, result: Authorization): Authorization {
  if (lease.applications.kind !== "selected" || result.decision === "deny") return result
  if (lease.applications.values.length !== 1 || !lease.applications.identity)
    return answer("deny", "Selected window has no stable process identity")
  return { ...result, windowID: lease.applications.values[0], identity: lease.applications.identity }
}

function invalidAdmission(request: AuthorizationRequest): boolean {
  if (!("admission" in request) || request.admission !== "computer_child") return false
  return !!(
    ("delegation" in request && request.delegation) ||
    request.surface !== "desktop" ||
    request.action !== "observe" ||
    request.sensitive ||
    request.windowID
  )
}

function selectedAdmission(lease: ComputerUseLease, request: AuthorizationRequest): Authorization | undefined {
  if (!("admission" in request) || request.admission !== "computer_child" || lease.applications.kind !== "selected")
    return
  if (lease.applications.values.length !== 1)
    return answer("deny", "Computer Use child admission needs one exact selected window")
  if (!lease.applications.identity) return answer("deny", "Selected window has no stable process identity")
  return {
    ...answer("allow", "Authorized by active Computer Use grant", lease.id),
    windowID: lease.applications.values[0],
    identity: lease.applications.identity,
  }
}

function mismatch(
  lease: ComputerUseLease,
  session: string,
  delegation: NonNullable<Extract<DesktopRequest, { operation: "authorize" }>["delegation"]>,
): boolean {
  return (
    delegation.childSessionID !== session ||
    delegation.parentSessionID === session ||
    delegation.grantID !== lease.id ||
    (lease.applications.kind === "selected"
      ? lease.applications.values.length !== 1 ||
        delegation.windowID !== lease.applications.values[0] ||
        delegation.identity !== lease.applications.identity
      : delegation.windowID !== undefined || delegation.identity !== undefined) ||
    (lease.lifetime.kind === "session" && lease.lifetime.sessionID !== delegation.parentSessionID)
  )
}

function check(input: GrantInput): void {
  if (typeof input.sessionID !== "string" || !input.sessionID || input.sessionID.length > 200)
    throw new Error("Computer Use grant needs a valid task identity")
  if (!["observe", "assisted", "autonomous"].includes(input.level))
    throw new Error("Choose a valid Computer Use control level")
  if (!["session", "hour", "until_stopped"].includes(input.duration))
    throw new Error("Choose a valid Computer Use duration")
  if (!["all", "current"].includes(input.applications)) throw new Error("Choose a valid Computer Use application scope")
  if (typeof input.cooperativeInput !== "boolean")
    throw new Error("Choose whether Computer Use pauses for manual input")
  if (!Array.isArray(input.actions)) throw new Error("Choose Computer Use action categories")
}

function checkSelection(input: GrantInput): void {
  if (input.applications !== "current") return
  if (
    typeof input.windowID !== "string" ||
    !input.windowID ||
    input.windowID.length > 200 ||
    typeof input.identity !== "string" ||
    !input.identity ||
    input.identity.length > 200
  )
    throw new Error("The current application is no longer available; choose all visible applications")
  if (input.duration !== "session")
    throw new Error(
      "Selected-application grants are limited to this task until stable application identity is available",
    )
}

function sensitive(lease: ComputerUseLease, request: AuthorizationRequest, parent?: string): Authorization | undefined {
  if (request.sensitive === true) return answer("ask", "This sensitive action requires a separate decision")
  if (!request.sensitive) return
  const rule = lease.sensitive[request.sensitive]
  if (rule === "deny") return answer("deny", "This sensitive action is denied by your policy")
  if (lease.level === "assisted") return answer("ask", "Assisted control asks before sensitive actions")
  if (rule === "ask") return answer("ask", "Your policy requires approval for this sensitive action")
  if (rule === "allow_session" && (parent ?? request.sessionID) !== lease.sensitiveSessionID)
    return answer("ask", "This sensitive action was allowed only for the original session")
}

function answer(decision: Authorization["decision"], reason: string, grantID?: string): Authorization {
  return { operation: "authorize", decision, reason, ...(grantID ? { grantID } : {}) }
}

function expired(lease: ComputerUseLease, now: number) {
  return lease.expiry.kind === "expires_at" && lease.expiry.expiresAt <= now
}

function decode(value: unknown): ComputerUseLease | undefined {
  if (!value || typeof value !== "object") return
  const lease = value as Record<string, unknown>
  if (!valid(lease)) return
  const lifetime = decodeLifetime(lease.lifetime)
  const expiry = decodeExpiry(lease.expiry)
  const applications = decodeScope(lease.applications)
  const monitors = decodeScope(lease.monitors)
  const sensitive = decodePolicy(lease.sensitive)
  if (!lifetime || !expiry || !applications || !monitors || !sensitive) return
  if (applications.kind === "selected" && !applications.identity) return
  if (!Array.isArray(lease.surfaces) || lease.surfaces.length < 1 || lease.surfaces.length > 3) return
  if (lease.surfaces.some((surface) => typeof surface !== "string" || !surfaces.has(surface))) return
  if (!Array.isArray(lease.actions) || lease.actions.length < 1 || lease.actions.length > 8) return
  if (lease.actions.some((action) => typeof action !== "string" || !actions.has(action as LeaseAction))) return
  return {
    version: 2,
    id: lease.id as string,
    level: lease.level as ControlLevel,
    state: lease.state as ComputerUseLease["state"],
    issuedAt: lease.issuedAt as number,
    lifetime,
    expiry,
    applications,
    monitors,
    surfaces: lease.surfaces as ComputerUseLease["surfaces"],
    actions: lease.actions as LeaseAction[],
    sensitive,
    sensitiveSessionID: lease.sensitiveSessionID as string,
    cooperativeInput: lease.cooperativeInput as boolean,
  }
}

function valid(lease: Record<string, unknown>) {
  if (lease.version !== 2) return false
  if (typeof lease.id !== "string" || lease.id.length < 1 || lease.id.length > 200) return false
  if (!["observe", "assisted", "autonomous"].includes(String(lease.level))) return false
  if (!["active", "paused", "revoked"].includes(String(lease.state))) return false
  if (typeof lease.issuedAt !== "number" || !Number.isFinite(lease.issuedAt)) return false
  if (typeof lease.sensitiveSessionID !== "string" || !lease.sensitiveSessionID) return false
  if (!decodePolicy(lease.sensitive)) return false
  return typeof lease.cooperativeInput === "boolean"
}

function decodePolicy(value: unknown): SensitivePolicy | undefined {
  const policy = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  if (!policy || categories.some((category) => !rules.has(policy[category] as SensitiveRule))) return
  return Object.fromEntries(categories.map((category) => [category, policy[category]])) as SensitivePolicy
}

function decodeLifetime(value: unknown): Lifetime | undefined {
  if (!value || typeof value !== "object") return
  const lifetime = value as Record<string, unknown>
  if (lifetime.kind === "all_sessions") return { kind: "all_sessions" }
  if (lifetime.kind !== "session" || typeof lifetime.sessionID !== "string" || !lifetime.sessionID) return
  return { kind: "session", sessionID: lifetime.sessionID }
}

function decodeExpiry(value: unknown): Expiry | undefined {
  if (!value || typeof value !== "object") return
  const expiry = value as Record<string, unknown>
  if (expiry.kind === "until_stopped") return { kind: "until_stopped" }
  if (expiry.kind !== "expires_at" || typeof expiry.expiresAt !== "number" || !Number.isFinite(expiry.expiresAt)) return
  return { kind: "expires_at", expiresAt: expiry.expiresAt }
}

function decodeScope(value: unknown): Scope | undefined {
  if (!value || typeof value !== "object") return
  const scope = value as Record<string, unknown>
  if (scope.kind === "all") return { kind: "all" }
  if (scope.kind !== "selected" || !Array.isArray(scope.values) || scope.values.length < 1 || scope.values.length > 64)
    return
  if (scope.values.some((item) => typeof item !== "string" || item.length < 1 || item.length > 200)) return
  if (
    scope.identity !== undefined &&
    (typeof scope.identity !== "string" || !scope.identity || scope.identity.length > 200)
  )
    return
  return { kind: "selected", values: scope.values as string[], ...(scope.identity ? { identity: scope.identity } : {}) }
}
