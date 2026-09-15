import { describe, expect, test } from "bun:test"
import { model } from "../../src/kilocode/process/env"

describe("model process environment", () => {
  test("removes both Raya and Kilo configuration inputs", () => {
    const names = [
      "KILO_CONFIG",
      "KILO_CONFIG_CONTENT",
      "KILO_CONFIG_DIR",
      "RAYA_CONFIG",
      "RAYA_CONFIG_CONTENT",
      "RAYA_CONFIG_DIR",
      "KILO_AUTH_CONTENT",
      "RAYA_AUTH_CONTENT",
      "KILO_DB",
      "RAYA_DB",
    ]
    const env = model(Object.fromEntries(names.map((name) => [name, "private"])))

    for (const name of names) expect(env[name]).toBeUndefined()
  })

  test("retains unrelated child environment values", () => {
    expect(model({ RAYA_ENV_ALIAS_TEST: "retained" }).RAYA_ENV_ALIAS_TEST).toBe("retained")
  })
})
