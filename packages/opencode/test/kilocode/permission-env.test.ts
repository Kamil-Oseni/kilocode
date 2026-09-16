import { describe, expect, test } from "bun:test"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { PermissionEnv } from "@/kilocode/config/permission-env"

function error(env: NodeJS.ProcessEnv) {
  try {
    PermissionEnv.resolve(env)
  } catch (cause) {
    return cause
  }
  throw new Error("Expected permission environment resolution to fail.")
}

describe("permission environment authority aliases", () => {
  test("omits an absent overlay", () => {
    expect(PermissionEnv.resolve({})).toBeUndefined()
  })

  test.each([
    ["Raya", { RAYA_PERMISSION: '{"bash":{"*":"deny","git *":"allow"}}' }, ["RAYA_PERMISSION"]],
    ["Kilo", { KILO_PERMISSION: '{"bash":{"*":"deny","git *":"allow"}}' }, ["KILO_PERMISSION"]],
  ] as const)("accepts one valid %s alias", (_name, env, labels) => {
    const result = PermissionEnv.resolve(env)
    expect(result?.labels).toEqual(labels)
    expect(result?.permission).toEqual({ bash: { "*": "deny", "git *": "allow" } })
  })

  test("accepts matching ordered overlay structures and applies one overlay", () => {
    const result = PermissionEnv.resolve({
      RAYA_PERMISSION: '{"bash":"deny","read":{"*":"allow","secret/*":"deny"}}',
      KILO_PERMISSION: '{ "bash": "deny", "read": { "*": "allow", "secret/*": "deny" } }',
    })

    expect(result?.labels).toEqual(["RAYA_PERMISSION", "KILO_PERMISSION"])
    expect(result?.permission).toEqual({ bash: "deny", read: { "*": "allow", "secret/*": "deny" } })
    expect(result?.labels.join("/")).toBe("RAYA_PERMISSION/KILO_PERMISSION")
  })

  test("normalizes an equivalent root scalar and wildcard overlay", () => {
    const result = PermissionEnv.resolve({ RAYA_PERMISSION: '"deny"', KILO_PERMISSION: '{"*":"deny"}' })
    expect(result?.permission).toEqual({ "*": "deny" })
  })

  test.each([
    ["different actions", '{"bash":{"*":"allow"}}', '{"bash":{"*":"deny"}}'],
    ["replace versus patch semantics", '{"bash":"deny"}', '{"bash":{"*":"deny"}}'],
    ["delete versus absent semantics", '{"bash":null}', "{}"],
    ["nested delete versus empty patch semantics", '{"bash":{"git *":null}}', '{"bash":{}}'],
    ["different nested order", '{"bash":{"*":"deny","git *":"allow"}}', '{"bash":{"git *":"allow","*":"deny"}}'],
    ["different top-level order", '{"bash":"deny","read":"allow"}', '{"read":"allow","bash":"deny"}'],
  ])("refuses %s", (_name, raya, kilo) => {
    const cause = error({ RAYA_PERMISSION: raya, KILO_PERMISSION: kilo })
    expect(ConfigErrorV1.InvalidError.isInstance(cause)).toBe(true)
    expect((cause as { data?: { path?: string } }).data?.path).toBe("RAYA_PERMISSION/KILO_PERMISSION")
  })

  test.each([
    ["malformed Raya", { RAYA_PERMISSION: "{raya-secret" }, "RAYA_PERMISSION"],
    ["malformed Kilo", { KILO_PERMISSION: "{legacy-secret" }, "KILO_PERMISSION"],
    ["empty Raya", { RAYA_PERMISSION: "" }, "RAYA_PERMISSION"],
    ["empty Kilo", { KILO_PERMISSION: "" }, "KILO_PERMISSION"],
    ["invalid Raya schema", { RAYA_PERMISSION: '{"bash":"raya-secret"}' }, "RAYA_PERMISSION"],
    ["invalid Kilo schema", { KILO_PERMISSION: '{"bash":"legacy-secret"}' }, "KILO_PERMISSION"],
    ["invalid Raya root", { RAYA_PERMISSION: '["raya-secret"]' }, "RAYA_PERMISSION"],
    [
      "valid Raya with invalid Kilo",
      { RAYA_PERMISSION: '{"bash":"deny"}', KILO_PERMISSION: '{"bash":"legacy-secret"}' },
      "KILO_PERMISSION",
    ],
    [
      "invalid Raya with valid Kilo",
      { RAYA_PERMISSION: '{"bash":"raya-secret"}', KILO_PERMISSION: '{"bash":"deny"}' },
      "RAYA_PERMISSION",
    ],
  ] as const)("fails closed for %s without exposing the value", (_name, env, path) => {
    const cause = error(env)
    expect(ConfigErrorV1.InvalidError.isInstance(cause)).toBe(true)
    expect((cause as { data?: { path?: string } }).data?.path).toBe(path)
    expect(JSON.stringify(cause)).not.toContain("secret")
    expect(String(cause)).not.toContain("secret")
  })

  test("does not expose either value when matching fails", () => {
    const cause = error({
      RAYA_PERMISSION: '{"raya-secret":"allow"}',
      KILO_PERMISSION: '{"legacy-secret":"deny"}',
    })
    const text = `${String(cause)} ${JSON.stringify(cause)}`
    expect(text).not.toContain("raya-secret")
    expect(text).not.toContain("legacy-secret")
    expect(text).toContain("RAYA_PERMISSION")
    expect(text).toContain("KILO_PERMISSION")
  })
})
