import { createHash, randomUUID } from "node:crypto"
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

type Scope =
  | { kind: "all" }
  | { kind: "selected"; values: string[]; identities: Record<string, string>; identity?: string }
type Lifetime = { kind: "session"; sessionID: string } | { kind: "all_sessions" }
type Expiry = { kind: "until_stopped" } | { kind: "expires_at"; expiresAt: number }

export type ComputerUseLease = {
  version: 3
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
  applications: "all" | "current" | "selected"
  windowID?: string
  identity?: string
  windows?: { windowID: string; identity: string }[]
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
const policyKey = "raya.computerUse.sensitivePolicy.v1"
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
  private policy: SensitivePolicy | undefined
  private readonly listeners = new Set<(lease: ComputerUseLease | undefined) => void>()
  private readonly sessions = new Set<string>()
  private readonly revoked = new Set<string>()
  private writes = Promise.resolve()
  private policyWrites = Promise.resolve()
  private revision = 0
  private pending: { id: string; revision: number; sessionID: string; durable: boolean } | undefined

  constructor(
    private readonly storage: LeaseStorage,
    private readonly now = () => Date.now(),
    private readonly revocations?: LeaseRevocations,
    private readonly unavailable?: string,
  ) {
    if (unavailable) return
    this.policy = decodeSavedPolicy(storage.get<unknown>(policyKey))
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

  /** Non-secret, side-effect-free status for installed-host diagnostics. */
  summary() {
    const lease = this.lease
    if (this.unavailable || !lease) return null
    return {
      grantHash: createHash("sha256").update(lease.id).digest("hex"),
      level: lease.level,
      state: expired(lease, this.now()) ? ("expired" as const) : lease.state,
      scopeCount: lease.applications.kind === "all" ? null : lease.applications.values.length,
      expiresAt: lease.expiry.kind === "expires_at" ? lease.expiry.expiresAt : null,
    }
  }

  savedPolicy(): SensitivePolicy | undefined {
    return this.policy ? { ...this.policy } : undefined
  }

  async savePolicy(value: SensitivePolicy): Promise<void> {
    if (this.unavailable) throw new Error(this.unavailable)
    const policy = decodePolicy(value)
    if (!policy) throw new Error("Choose a policy for every sensitive action category")
    this.policyWrites = this.policyWrites
      .catch(() => undefined)
      .then(() => Promise.resolve(this.storage.update(policyKey, { version: 1, sensitive: policy })))
    await this.policyWrites
    this.policy = policy
  }

  async clearPolicy(): Promise<void> {
    if (this.unavailable) throw new Error(this.unavailable)
    this.policyWrites = this.policyWrites
      .catch(() => undefined)
      .then(() => Promise.resolve(this.storage.update(policyKey, undefined)))
    await this.policyWrites
    this.policy = undefined
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
      version: 3,
      id: randomUUID(),
      level: input.level,
      state: "active",
      issuedAt: now,
      lifetime:
        input.duration === "session" ? { kind: "session", sessionID: input.sessionID } : { kind: "all_sessions" },
      expiry:
        input.duration === "hour" ? { kind: "expires_at", expiresAt: now + 60 * 60 * 1000 } : { kind: "until_stopped" },
      applications: selection(input),
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
      return selectedResult(
        lease,
        request,
        delegation && policy.decision === "ask" ? { ...policy, grantID: lease.id } : policy,
      )
    const result =
      selectedAdmission(lease, request) ?? answer("allow", "Authorized by active Computer Use grant", lease.id)
    if (result.decision === "allow") this.sessions.add(request.sessionID)
    return selectedResult(lease, request, result)
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
  const boundary = selectedScope(lease, request)
  if (boundary) return boundary
  if (lease.level === "observe" && request.action !== "observe")
    return answer("deny", "Observe only cannot control the desktop")
  if (!lease.actions.includes(request.action)) return answer("ask", "This action is outside the grant")
}

function selectedScope(lease: ComputerUseLease, request: AuthorizationRequest): Authorization | undefined {
  if (lease.applications.kind !== "selected") return
  if (request.surface !== "desktop") return answer("deny", "Selected window grants apply only to this desktop window")
  if (request.target && request.target.windowID !== request.windowID)
    return answer("deny", "The selected desktop target differs from its authorization window")
  if ("admission" in request && request.admission === "computer_child") return
  const delegation = "delegation" in request ? request.delegation : undefined
  const window =
    request.windowID ??
    delegation?.windowID ??
    (request.action === "observe" && lease.applications.values.length === 1 ? lease.applications.values[0] : undefined)
  if (!window || !lease.applications.values.includes(window))
    return answer("deny", "This application is outside the selected grant")
  if (delegation && request.windowID && request.windowID !== delegation.windowID)
    return answer("deny", "The requested window differs from the delegated window")
}

function missing(session: string, delegation: boolean, revoked: Set<string>): Authorization {
  return delegation || revoked.has(session)
    ? answer("deny", "Computer Use was stopped for this task")
    : answer("ask", "No active Computer Use grant")
}

function limited(result: Authorization, delegation: boolean): Authorization {
  return delegation && result.decision === "ask" ? { ...result, decision: "deny" } : result
}

function selectedResult(lease: ComputerUseLease, request: AuthorizationRequest, result: Authorization): Authorization {
  if (lease.applications.kind !== "selected" || result.decision === "deny") return result
  const delegation = "delegation" in request ? request.delegation : undefined
  const window =
    request.windowID ??
    delegation?.windowID ??
    (lease.applications.values.length === 1 ? lease.applications.values[0] : undefined)
  const identity = window ? lease.applications.identities[window] : undefined
  if (!window || !identity) return answer("deny", "Selected window has no stable process identity")
  return { ...result, windowID: window, identity }
}

function invalidAdmission(request: AuthorizationRequest): boolean {
  if (!("admission" in request) || request.admission !== "computer_child") return false
  return !!(
    ("delegation" in request && request.delegation) ||
    request.surface !== "desktop" ||
    request.action !== "observe" ||
    request.sensitive ||
    request.windowID ||
    request.target
  )
}

function selectedAdmission(lease: ComputerUseLease, request: AuthorizationRequest): Authorization | undefined {
  if (!("admission" in request) || request.admission !== "computer_child" || lease.applications.kind !== "selected")
    return
  if (lease.applications.values.length !== 1)
    return answer("deny", "Computer Use child admission needs one exact selected window")
  const identity = lease.applications.identities[lease.applications.values[0]!]
  if (!identity) return answer("deny", "Selected window has no stable process identity")
  return {
    ...answer("allow", "Authorized by active Computer Use grant", lease.id),
    windowID: lease.applications.values[0],
    identity,
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
      ? !delegation.windowID ||
        !lease.applications.values.includes(delegation.windowID) ||
        delegation.identity !== lease.applications.identities[delegation.windowID]
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
  if (!["all", "current", "selected"].includes(input.applications))
    throw new Error("Choose a valid Computer Use application scope")
  if (typeof input.cooperativeInput !== "boolean")
    throw new Error("Choose whether Computer Use pauses for manual input")
  if (!Array.isArray(input.actions)) throw new Error("Choose Computer Use action categories")
}

function checkSelection(input: GrantInput): void {
  if (input.applications === "all") {
    if (input.windowID !== undefined || input.identity !== undefined || input.windows !== undefined)
      throw new Error("All-application grants cannot include selected windows")
    return
  }
  if (input.applications === "current") {
    if (!validWindow(input.windowID, input.identity) || input.windows !== undefined)
      throw new Error("The current application is no longer available; choose all visible applications")
  }
  if (input.applications === "selected") {
    if (
      input.windowID !== undefined ||
      input.identity !== undefined ||
      !Array.isArray(input.windows) ||
      input.windows.length < 1 ||
      input.windows.length > 64 ||
      input.windows.some((window) => !window || !validWindow(window.windowID, window.identity)) ||
      new Set(input.windows.map((window) => window.windowID)).size !== input.windows.length
    )
      throw new Error("Choose distinct visible windows with a stable identity for each")
  }
  if (input.duration !== "session")
    throw new Error(
      "Selected-application grants are limited to this task until stable application identity is available",
    )
}

function validWindow(window: unknown, identity: unknown): boolean {
  return (
    typeof window === "string" &&
    !!window &&
    window.length <= 200 &&
    typeof identity === "string" &&
    !!identity &&
    identity.length <= 200
  )
}

function selection(input: GrantInput): Scope {
  if (input.applications === "all") return { kind: "all" }
  const windows =
    input.applications === "current" ? [{ windowID: input.windowID!, identity: input.identity! }] : input.windows!
  return {
    kind: "selected",
    values: windows.map((window) => window.windowID),
    identities: Object.fromEntries(windows.map((window) => [window.windowID, window.identity])),
    ...(windows.length === 1 ? { identity: windows[0]!.identity } : {}),
  }
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
  const applications = decodeScope(lease.applications, lease.version)
  const monitors = decodeScope(lease.monitors, lease.version)
  const sensitive = decodePolicy(lease.sensitive)
  if (!lifetime || !expiry || !applications || !monitors || !sensitive) return
  if (monitors.kind !== "all") return
  if (!Array.isArray(lease.surfaces) || lease.surfaces.length < 1 || lease.surfaces.length > 3) return
  if (lease.surfaces.some((surface) => typeof surface !== "string" || !surfaces.has(surface))) return
  if (!Array.isArray(lease.actions) || lease.actions.length < 1 || lease.actions.length > 8) return
  if (lease.actions.some((action) => typeof action !== "string" || !actions.has(action as LeaseAction))) return
  return {
    version: 3,
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
  if (lease.version !== 2 && lease.version !== 3) return false
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

function decodeSavedPolicy(value: unknown): SensitivePolicy | undefined {
  if (!value || typeof value !== "object") return
  const saved = value as Record<string, unknown>
  if (saved.version !== 1) return
  return decodePolicy(saved.sensitive)
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

function decodeScope(value: unknown, version: unknown): Scope | undefined {
  if (!value || typeof value !== "object") return
  const scope = value as Record<string, unknown>
  if (scope.kind === "all") return { kind: "all" }
  if (scope.kind !== "selected" || !Array.isArray(scope.values) || scope.values.length < 1 || scope.values.length > 64)
    return
  if (scope.values.some((item) => typeof item !== "string" || item.length < 1 || item.length > 200)) return
  const values = scope.values as string[]
  if (new Set(values).size !== values.length) return
  return version === 2 ? decodeOldSelection(scope, values) : decodeSelection(scope, values)
}

function decodeOldSelection(scope: Record<string, unknown>, values: string[]): Scope | undefined {
  if (values.length !== 1 || !validWindow(values[0], scope.identity)) return
  return {
    kind: "selected",
    values,
    identities: { [values[0]!]: scope.identity as string },
    identity: scope.identity as string,
  }
}

function decodeSelection(scope: Record<string, unknown>, values: string[]): Scope | undefined {
  if (!scope.identities || typeof scope.identities !== "object" || Array.isArray(scope.identities)) return
  const identities = scope.identities as Record<string, unknown>
  if (
    Object.keys(identities).length !== values.length ||
    values.some((window) => !validWindow(window, identities[window]))
  )
    return
  if (scope.identity !== undefined && (values.length !== 1 || scope.identity !== identities[values[0]!])) return
  return {
    kind: "selected",
    values,
    identities: Object.fromEntries(values.map((window) => [window, identities[window] as string])),
    ...(values.length === 1 ? { identity: identities[values[0]!] as string } : {}),
  }
}
