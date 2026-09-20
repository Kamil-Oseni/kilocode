import { describe, expect, test } from "bun:test"
import { ToolInputRepair } from "@/kilocode/session/tool-input-repair"

describe("ToolInputRepair.complete", () => {
  test("completes only missing structural delimiters", () => {
    expect(ToolInputRepair.complete('{"path":"report.md","options":{"lines":[1,2]')).toBe(
      '{"path":"report.md","options":{"lines":[1,2]}}',
    )
    expect(ToolInputRepair.complete('  {"path":"report.md"  ')).toBe('{"path":"report.md"}')
  })

  test("refuses ambiguous, malformed, valid, non-object, and oversized input", () => {
    expect(ToolInputRepair.complete('{"path":"report')).toBeUndefined()
    expect(ToolInputRepair.complete('{"path":')).toBeUndefined()
    expect(ToolInputRepair.complete('{"path":"report.md",')).toBeUndefined()
    expect(ToolInputRepair.complete("{'path':'report.md'}")).toBeUndefined()
    expect(ToolInputRepair.complete('{"path":"report.md"}')).toBeUndefined()
    expect(ToolInputRepair.complete('[{"path":"report.md"')).toBeUndefined()
    expect(ToolInputRepair.complete(`{"path":"${"x".repeat(1024 * 1024)}"`)).toBeUndefined()
  })
})
