// raya_change - Milestone I SecretStorage contract
import { describe, expect, it } from "bun:test"
import { ProviderSecretStore } from "../../src/provider-secrets"

describe("ProviderSecretStore", () => {
  it("round-trips and deletes BYOK keys through SecretStorage only", async () => {
    const values = new Map<string, string>()
    const calls: string[] = []
    const storage = {
      get: async (key: string) => {
        calls.push(`get:${key}`)
        return values.get(key)
      },
      store: async (key: string, value: string) => {
        calls.push(`store:${key}`)
        values.set(key, value)
      },
      delete: async (key: string) => {
        calls.push(`delete:${key}`)
        values.delete(key)
      },
    }
    const secrets = new ProviderSecretStore(storage)

    await secrets.set("deepseek", "sk-secret")
    expect(await secrets.get("deepseek")).toBe("sk-secret")
    await secrets.delete("deepseek")
    expect(await secrets.get("deepseek")).toBeUndefined()
    expect(calls).toEqual([
      "store:raya.provider.deepseek",
      "get:raya.provider.deepseek",
      "delete:raya.provider.deepseek",
      "get:raya.provider.deepseek",
    ])
  })
})
