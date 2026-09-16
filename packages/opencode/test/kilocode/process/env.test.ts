import { expect, test } from "bun:test"
import { model } from "@/kilocode/process/env"

test("removes Raya and legacy server credentials after merging caller environment", () => {
  const names = ["RAYA_SERVER_PASSWORD", "RAYA_SERVER_USERNAME", "KILO_SERVER_PASSWORD", "KILO_SERVER_USERNAME"]
  const env = model(Object.fromEntries([...names.map((name) => [name, "private"]), ["SAFE_VALUE", "visible"]]))

  expect(env.SAFE_VALUE).toBe("visible")
  for (const name of names) expect(env).not.toHaveProperty(name)
})
