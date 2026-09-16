import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Option, Redacted } from "effect" // kilocode_change
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

// kilocode_change start - preserve both credential aliases across tests
const original = {
  rayaPassword: process.env.RAYA_SERVER_PASSWORD,
  kiloPassword: process.env.KILO_SERVER_PASSWORD,
  rayaUsername: process.env.RAYA_SERVER_USERNAME,
  kiloUsername: process.env.KILO_SERVER_USERNAME,
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore("RAYA_SERVER_PASSWORD", original.rayaPassword)
  restore("KILO_SERVER_PASSWORD", original.kiloPassword)
  restore("RAYA_SERVER_USERNAME", original.rayaUsername)
  restore("KILO_SERVER_USERNAME", original.kiloUsername)
})
// kilocode_change end

describe("ServerAuth", () => {
  // kilocode_change start - strict credential alias coverage
  test("accepts either credential alias and identical pairs", () => {
    expect(ServerAuth.resolve(undefined, { RAYA_SERVER_PASSWORD: "raya-secret" })).toEqual({
      password: Option.some("raya-secret"),
      username: "kilo",
    })
    expect(ServerAuth.resolve(undefined, { KILO_SERVER_USERNAME: "legacy-user" })).toEqual({
      password: Option.none(),
      username: "legacy-user",
    })
    expect(
      ServerAuth.resolve(undefined, {
        RAYA_SERVER_PASSWORD: "same-secret",
        KILO_SERVER_PASSWORD: "same-secret",
        RAYA_SERVER_USERNAME: "same-user",
        KILO_SERVER_USERNAME: "same-user",
      }),
    ).toEqual({ password: Option.some("same-secret"), username: "same-user" })
  })

  test("rejects conflicting aliases without exposing values", () => {
    const env = { RAYA_SERVER_PASSWORD: "raya-secret", KILO_SERVER_PASSWORD: "legacy-secret" }
    expect(() => ServerAuth.resolve(undefined, env)).toThrow("RAYA_SERVER_PASSWORD and KILO_SERVER_PASSWORD")
    try {
      ServerAuth.resolve(undefined, env)
    } catch (err) {
      const message = String(err)
      expect(message).not.toContain("raya-secret")
      expect(message).not.toContain("legacy-secret")
    }
  })

  test("explicit credentials override hostile ambient aliases", () => {
    expect(
      ServerAuth.resolve(
        { password: "explicit-secret", username: "explicit-user" },
        {
          RAYA_SERVER_PASSWORD: "raya-secret",
          KILO_SERVER_PASSWORD: "legacy-secret",
          RAYA_SERVER_USERNAME: "raya-user",
          KILO_SERVER_USERNAME: "legacy-user",
        },
      ),
    ).toEqual({ password: Option.some("explicit-secret"), username: "explicit-user" })
  })

  test("preserves an explicit empty password as unauthenticated", () => {
    const config = ServerAuth.resolve({ password: "" }, { KILO_SERVER_PASSWORD: "legacy-secret" })
    expect(config).toEqual({ password: Option.some(""), username: "kilo" })
    expect(ServerAuth.required(config)).toBe(false)
  })

  test("loads aliases through Effect config with the Kilo username default", async () => {
    const load = (input: Record<string, string>) =>
      Effect.runPromise(
        ServerAuth.Config.pipe(
          Effect.provide(ServerAuth.Config.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
        ),
      )

    expect(await load({ RAYA_SERVER_PASSWORD: "raya-secret" })).toEqual({
      password: Option.some("raya-secret"),
      username: "kilo",
    })
    const error = await load({ RAYA_SERVER_USERNAME: "raya-user", KILO_SERVER_USERNAME: "legacy-user" }).catch(
      (cause) => cause,
    )
    expect(String(error)).toContain("RAYA_SERVER_USERNAME")
    expect(String(error)).toContain("KILO_SERVER_USERNAME")
    expect(String(error)).not.toContain("raya-user")
    expect(String(error)).not.toContain("legacy-user")
  })
  // kilocode_change end

  test("does not emit auth headers without a password", () => {
    Flag.KILO_SERVER_PASSWORD = undefined
    Flag.KILO_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the kilo username", () => {
    // kilocode_change
    Flag.KILO_SERVER_PASSWORD = "secret"
    Flag.KILO_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("kilo:secret").toString("base64")}`, // kilocode_change
    })
  })

  test("uses the configured username", () => {
    Flag.KILO_SERVER_PASSWORD = "secret"
    Flag.KILO_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.KILO_SERVER_PASSWORD = "secret"
    Flag.KILO_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "kilo", password: Redacted.make("secret") }, config)).toBe(false) // kilocode_change
  })
})
