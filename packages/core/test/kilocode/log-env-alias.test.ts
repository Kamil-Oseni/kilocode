import { afterEach, describe, expect, test } from "bun:test"
import { minimumLogLevel, loggers } from "../../src/observability/logging"
import { EnvAlias } from "../../src/kilocode/env-alias"

const names = ["RAYA_LOG_LEVEL", "KILO_LOG_LEVEL", "RAYA_PRINT_LOGS", "KILO_PRINT_LOGS"] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  EnvAlias.conflicts()
})

describe("Raya Effect log aliases", () => {
  test("prefers Raya values and retains Kilo fallbacks", () => {
    delete process.env.RAYA_LOG_LEVEL
    delete process.env.RAYA_PRINT_LOGS
    process.env.KILO_LOG_LEVEL = "debug"
    process.env.KILO_PRINT_LOGS = "1"
    expect(minimumLogLevel()).toBe("Debug")
    expect(loggers()).toHaveLength(2)

    process.env.RAYA_LOG_LEVEL = "error"
    process.env.RAYA_PRINT_LOGS = "0"
    expect(minimumLogLevel()).toBe("Error")
    expect(loggers()).toHaveLength(1)
  })
})
