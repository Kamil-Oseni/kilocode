import { describe, expect, test } from "bun:test"
import { print } from "../env.js"

describe("Raya telemetry log alias", () => {
  test("prefers Raya input and retains exact Kilo truthiness", () => {
    expect(print({})).toBe(false)
    expect(print({ KILO_PRINT_LOGS: "1" })).toBe(true)
    expect(print({ KILO_PRINT_LOGS: "0" })).toBe(true)
    expect(print({ RAYA_PRINT_LOGS: "1" })).toBe(true)
    expect(print({ RAYA_PRINT_LOGS: "", KILO_PRINT_LOGS: "1" })).toBe(false)
  })
})
