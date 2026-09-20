import { describe, expect, test } from "bun:test"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { action, find, rules, validate } from "@opencode-ai/core/kilocode/migration-policy"

describe("destructive database migration policy", () => {
  test("records every known destructive transition and its shipped release boundary", () => {
    expect(rules.map((rule) => rule.id)).toEqual([
      "20260303231226_add_workspace_fields",
      "20260309230000_move_org_to_state",
      "20260427172553_slow_nightmare",
      "20260601202201_amazing_prowler",
      "20260603040000_session_message_projection_order",
      "20260604172448_event_sourced_session_input",
      "20260611192811_lush_chimera",
      "20260622142730_simplify_session_context_epoch",
      "20260622170816_reset_v2_session_state",
      "20260622202450_simplify_session_input",
    ])
    expect(rules.every((rule) => rule.action === action)).toBe(true)
    expect(rules.every((rule) => rule.lineage === "sqlite-upgrade")).toBe(true)
    expect(rules.map((rule) => [rule.nearestPriorRelease, rule.firstRelease])).toEqual([
      ["7.0.47", "7.0.48"],
      ["7.2.3", "7.2.4"],
      ["7.3.1", "7.3.2"],
      ["7.4.7", "7.4.8"],
      ["7.4.7", "7.4.8"],
      ["7.4.7", "7.4.8"],
      ["7.4.15", "7.4.16"],
      ["7.4.20", "7.4.21"],
      ["7.4.20", "7.4.21"],
      ["7.4.20", "7.4.21"],
    ])
    expect(rules.filter((rule) => rule.firstRelease === "7.4.8")).toHaveLength(3)
    expect(rules.filter((rule) => rule.firstRelease === "7.4.16")).toHaveLength(1)
    expect(rules.filter((rule) => rule.firstRelease === "7.4.21")).toHaveLength(3)
    expect(find("20260622170816_reset_v2_session_state")).toMatchObject({
      nearestPriorRelease: "7.4.20",
      firstRelease: "7.4.21",
      lineage: "sqlite-upgrade",
      recovery: "export-and-open-with-compatible-pre-reset-runtime",
    })
    validate(migrations)
  })

  test("fails closed when policy and the registered migration graph differ", () => {
    expect(() => validate(migrations.filter((migration) => migration.id !== rules[0].id))).toThrow(
      `Destructive database migration policy has no migration: ${rules[0].id}`,
    )
    expect(() => validate([migrations[0], migrations[0]])).toThrow("Database migration identifiers must be unique.")
  })
})
