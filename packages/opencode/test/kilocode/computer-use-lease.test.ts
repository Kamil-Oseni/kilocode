// raya_change - autonomous Computer Use capability lease contract tests
import { describe, expect, test } from "bun:test"
import { GrantID, Lease, decide, type Request } from "@/kilocode/computer-use/lease"
import { Schema } from "effect"

const base: Lease = {
  version: 2,
  id: GrantID.make("grant_test"),
  level: "autonomous",
  state: "active",
  issuedAt: 100,
  lifetime: { kind: "session", sessionID: "session_test" },
  expiry: { kind: "expires_at", expiresAt: 1_000 },
  applications: { kind: "selected", values: ["app_editor"] },
  monitors: { kind: "selected", values: ["monitor_primary"] },
  surfaces: ["desktop"],
  actions: ["observe", "pointer", "keyboard"],
  sensitive: {
    communications: "ask",
    financial: "deny",
    credentials: "deny",
    software: "ask",
    system: "ask",
    deletion: "ask",
    disclosure: "ask",
    legal: "deny",
    publishing: "allow_session",
  },
  sensitiveSessionID: "session_test",
  cooperativeInput: false,
}

const request: Request = {
  sessionID: "session_test",
  surface: "desktop",
  action: "pointer",
  application: "app_editor",
  monitor: "monitor_primary",
}

describe("Computer Use capability lease", () => {
  test("decodes a bounded versioned lease and authorizes an ordinary scoped action", () => {
    const lease = Schema.decodeUnknownSync(Lease)(base)
    expect(decide(lease, request, 500)).toEqual({ decision: "allow", reason: "authorized" })
  })

  test("falls back to a prompt when there is no applicable grant", () => {
    expect(decide(undefined, request, 500)).toEqual({ decision: "ask", reason: "missing" })
    expect(decide(base, { ...request, sessionID: "session_other" }, 500)).toEqual({
      decision: "ask",
      reason: "session",
    })
    expect(decide(base, { ...request, application: "app_other" }, 500)).toEqual({
      decision: "ask",
      reason: "application",
    })
    expect(decide(base, { ...request, action: "scroll" }, 500)).toEqual({
      decision: "ask",
      reason: "action",
    })
  })

  test("fails closed for paused, revoked, expired, observe-only, and sensitive actions", () => {
    expect(decide({ ...base, state: "paused" }, request, 500)).toEqual({ decision: "deny", reason: "paused" })
    expect(decide({ ...base, state: "revoked" }, request, 500)).toEqual({ decision: "deny", reason: "revoked" })
    expect(decide(base, request, 1_000)).toEqual({ decision: "deny", reason: "expired" })
    expect(decide({ ...base, level: "observe" }, request, 500)).toEqual({
      decision: "deny",
      reason: "observe_only",
    })
    expect(decide(base, { ...request, sensitive: true }, 500)).toEqual({
      decision: "ask",
      reason: "sensitive_ask",
    })
    expect(decide(base, { ...request, sensitive: "financial" }, 500)).toEqual({
      decision: "deny",
      reason: "sensitive_denied",
    })
    expect(decide(base, { ...request, sensitive: "publishing", sessionID: "session_other" }, 500)).toEqual({
      decision: "ask",
      reason: "session",
    })
  })

  test("supports an all-session lease without weakening selected application and monitor scope", () => {
    const lease: Lease = {
      ...base,
      lifetime: { kind: "all_sessions" },
      expiry: { kind: "until_stopped" },
      level: "assisted",
    }
    expect(decide(lease, { ...request, sessionID: "session_other" }, 50_000)).toEqual({
      decision: "allow",
      reason: "authorized",
    })
    expect(decide(lease, { ...request, monitor: undefined }, 50_000)).toEqual({
      decision: "ask",
      reason: "monitor",
    })
  })

  test("applies deny, ask, session-only, and persistent sensitive policy choices", () => {
    const lease: Lease = {
      ...base,
      lifetime: { kind: "all_sessions" },
      applications: { kind: "all" },
      monitors: { kind: "all" },
    }
    expect(decide(lease, { ...request, sensitive: "financial" }, 500)).toEqual({
      decision: "deny",
      reason: "sensitive_denied",
    })
    expect(decide(lease, { ...request, sensitive: "communications" }, 500)).toEqual({
      decision: "ask",
      reason: "sensitive_ask",
    })
    expect(decide(lease, { ...request, sensitive: "publishing" }, 500)).toEqual({
      decision: "allow",
      reason: "authorized",
    })
    expect(decide(lease, { ...request, sensitive: "publishing", sessionID: "session_other" }, 500)).toEqual({
      decision: "ask",
      reason: "sensitive_session",
    })
    const always: Lease = { ...lease, sensitive: { ...lease.sensitive, publishing: "allow_always" } }
    expect(decide(always, { ...request, sensitive: "publishing", sessionID: "session_other" }, 500)).toEqual({
      decision: "allow",
      reason: "authorized",
    })
  })

  test("rejects empty selected scopes and unbounded scope arrays", () => {
    expect(() => Schema.decodeUnknownSync(Lease)({ ...base, applications: { kind: "selected", values: [] } })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Lease)({
        ...base,
        applications: { kind: "selected", values: Array.from({ length: 65 }, (_, index) => `app_${index}`) },
      }),
    ).toThrow()
  })
})
