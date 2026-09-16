// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Option } from "effect"
import { ServerAuth } from "../src/auth"

const names = ["RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", "RAYA_SERVER_USERNAME", "KILO_SERVER_USERNAME"] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function clear() {
  for (const name of names) delete process.env[name]
}

function decode(header: string) {
  return Buffer.from(header.slice("Basic ".length), "base64").toString()
}

describe("ServerAuth Raya aliases", () => {
  test("uses one-sided and matching aliases with the generic username default", () => {
    clear()
    process.env.RAYA_SERVER_PASSWORD = "raya-secret"
    expect(decode(ServerAuth.header() ?? "")).toBe("opencode:raya-secret")

    clear()
    process.env.KILO_SERVER_PASSWORD = "legacy-secret"
    expect(decode(ServerAuth.header() ?? "")).toBe("opencode:legacy-secret")

    process.env.KILO_SERVER_PASSWORD = "raya-secret"
    process.env.RAYA_SERVER_PASSWORD = "raya-secret"
    process.env.RAYA_SERVER_USERNAME = "alice"
    expect(decode(ServerAuth.header() ?? "")).toBe("alice:raya-secret")
  })

  test("prefers defined explicit credentials, including empty password", () => {
    clear()
    process.env.RAYA_SERVER_PASSWORD = "raya-secret"
    process.env.KILO_SERVER_PASSWORD = "legacy-secret"
    process.env.RAYA_SERVER_USERNAME = "raya-user"
    process.env.KILO_SERVER_USERNAME = "legacy-user"

    expect(decode(ServerAuth.header({ username: "explicit-user", password: "explicit-secret" }) ?? "")).toBe(
      "explicit-user:explicit-secret",
    )
    expect(ServerAuth.header({ username: "explicit-user", password: "" })).toBeUndefined()

    clear()
    process.env.RAYA_SERVER_PASSWORD = ""
    expect(ServerAuth.header()).toBeUndefined()
  })

  test("fails closed without exposing conflicting values", () => {
    clear()
    process.env.RAYA_SERVER_PASSWORD = "raya-secret"
    process.env.KILO_SERVER_PASSWORD = "legacy-secret"

    expect(() => ServerAuth.header()).toThrow("RAYA_SERVER_PASSWORD and KILO_SERVER_PASSWORD")
    try {
      ServerAuth.header()
    } catch (cause) {
      expect(String(cause)).not.toContain("raya-secret")
      expect(String(cause)).not.toContain("legacy-secret")
    }
  })

  test("loads aliases through the Effect config provider and rejects conflicts", async () => {
    const load = (input: Record<string, string>) =>
      Effect.runPromise(
        ServerAuth.Config.pipe(
          Effect.provide(ServerAuth.Config.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
        ),
      )

    const config = await load({ RAYA_SERVER_PASSWORD: "secret", KILO_SERVER_USERNAME: "kit" })
    expect(config).toEqual({ password: Option.some("secret"), username: "kit" })
    expect(await load({ RAYA_SERVER_PASSWORD: "" })).toEqual({ password: Option.some(""), username: "opencode" })

    const error = await load({ RAYA_SERVER_PASSWORD: "first", KILO_SERVER_PASSWORD: "second" }).catch((cause) => cause)
    expect(String(error)).toContain("RAYA_SERVER_PASSWORD")
    expect(String(error)).toContain("KILO_SERVER_PASSWORD")
    expect(String(error)).not.toContain("first")
    expect(String(error)).not.toContain("second")
  })
})
