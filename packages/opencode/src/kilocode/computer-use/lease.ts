// raya_change - autonomous Computer Use capability lease contract
import { Schema } from "effect"

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const Time = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))

export const GrantID = Identity.pipe(Schema.brand("ComputerUseGrantID")).annotate({
  identifier: "ComputerUseGrantID",
})
export type GrantID = Schema.Schema.Type<typeof GrantID>

export const Level = Schema.Literals(["observe", "assisted", "autonomous"])
export type Level = Schema.Schema.Type<typeof Level>

export const Surface = Schema.Literals(["browser", "desktop", "mobile"])
export type Surface = Schema.Schema.Type<typeof Surface>

export const Action = Schema.Literals([
  "observe",
  "pointer",
  "keyboard",
  "scroll",
  "window",
  "launch",
  "browser",
  "files",
])
export type Action = Schema.Schema.Type<typeof Action>

export const SensitiveCategory = Schema.Literals([
  "communications",
  "financial",
  "credentials",
  "software",
  "system",
  "deletion",
  "disclosure",
  "legal",
  "publishing",
])
export type SensitiveCategory = Schema.Schema.Type<typeof SensitiveCategory>

export const ActionClassification = Schema.Union([Schema.Literal("ordinary"), SensitiveCategory]).annotate({
  description:
    "Classify the intended effect as ordinary or as one sensitive policy category before local dispatch.",
})
export type ActionClassification = Schema.Schema.Type<typeof ActionClassification>
export const ClassifiedAction = Schema.Struct({ sensitive_category: ActionClassification })

export const SensitiveRule = Schema.Literals(["allow_session", "allow_always", "ask", "deny"])
export type SensitiveRule = Schema.Schema.Type<typeof SensitiveRule>

const SensitivePolicy = Schema.Record(SensitiveCategory, SensitiveRule)

const Selected = Schema.Struct({
  kind: Schema.Literal("selected"),
  values: Schema.Array(Identity).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
const Scope = Schema.Union([Schema.Struct({ kind: Schema.Literal("all") }), Selected])

export const Lifetime = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session"), sessionID: Identity }),
  Schema.Struct({ kind: Schema.Literal("all_sessions") }),
])

export const Expiry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("until_stopped") }),
  Schema.Struct({ kind: Schema.Literal("expires_at"), expiresAt: Time }),
])

export const Lease = Schema.Struct({
  version: Schema.Literal(2),
  id: GrantID,
  level: Level,
  state: Schema.Literals(["active", "paused", "revoked"]),
  issuedAt: Time,
  lifetime: Lifetime,
  expiry: Expiry,
  applications: Scope,
  monitors: Scope,
  surfaces: Schema.Array(Surface).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  actions: Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  sensitive: SensitivePolicy,
  sensitiveSessionID: Identity,
  cooperativeInput: Schema.Boolean,
}).annotate({ identifier: "ComputerUseLease" })
export type Lease = Schema.Schema.Type<typeof Lease>

export type Request = {
  sessionID: string
  surface: Surface
  action: Action
  application?: string
  monitor?: string
  sensitive?: SensitiveCategory | boolean
}

export type Decision = {
  decision: "allow" | "ask" | "deny"
  reason:
    | "authorized"
    | "missing"
    | "paused"
    | "revoked"
    | "expired"
    | "session"
    | "surface"
    | "application"
    | "monitor"
    | "action"
    | "observe_only"
    | "sensitive_ask"
    | "sensitive_denied"
    | "sensitive_session"
}

export function decide(lease: Lease | undefined, request: Request, now = Date.now()): Decision {
  if (!lease) return { decision: "ask", reason: "missing" }
  if (lease.state === "paused") return { decision: "deny", reason: "paused" }
  if (lease.state === "revoked") return { decision: "deny", reason: "revoked" }
  if (lease.expiry.kind === "expires_at" && lease.expiry.expiresAt <= now)
    return { decision: "deny", reason: "expired" }
  if (lease.lifetime.kind === "session" && lease.lifetime.sessionID !== request.sessionID)
    return { decision: "ask", reason: "session" }
  if (!lease.surfaces.includes(request.surface)) return { decision: "ask", reason: "surface" }
  if (!within(lease.applications, request.application)) return { decision: "ask", reason: "application" }
  if (!within(lease.monitors, request.monitor)) return { decision: "ask", reason: "monitor" }
  if (lease.level === "observe" && request.action !== "observe") return { decision: "deny", reason: "observe_only" }
  if (!lease.actions.includes(request.action)) return { decision: "ask", reason: "action" }
  if (request.sensitive === true) return { decision: "ask", reason: "sensitive_ask" }
  if (request.sensitive) {
    const rule = lease.sensitive[request.sensitive]
    if (rule === "deny") return { decision: "deny", reason: "sensitive_denied" }
    if (rule === "ask") return { decision: "ask", reason: "sensitive_ask" }
    if (rule === "allow_session" && request.sessionID !== lease.sensitiveSessionID)
      return { decision: "ask", reason: "sensitive_session" }
  }
  return { decision: "allow", reason: "authorized" }
}

function within(scope: Schema.Schema.Type<typeof Scope>, value: string | undefined) {
  if (scope.kind === "all") return true
  if (!value) return false
  return scope.values.includes(value)
}
