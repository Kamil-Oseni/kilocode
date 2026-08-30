import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

describe("PermissionDeniedError message", () => {
  test("does not blame the user for an agent-owned deny rule", () => {
    const err = new PermissionV1.DeniedError({
      ruleset: { permission: "*", pattern: "*", action: "deny", source: "agent" },
    })
    expect(err.message).toContain("This agent is not allowed to use this tool directly")
    expect(err.message).toContain("task tool")
    expect(err.message).not.toContain("The user has specified a rule")
  })

  test("still attributes a user/config deny to the user", () => {
    const err = new PermissionV1.DeniedError({
      ruleset: [{ permission: "edit", pattern: "*", action: "deny" }],
    })
    expect(err.message).toContain("The user has specified a rule which prevents you from using this specific tool call")
  })
})
