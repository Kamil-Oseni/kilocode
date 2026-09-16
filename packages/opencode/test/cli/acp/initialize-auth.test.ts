import { describe, expect } from "bun:test"
import type { AuthenticateResponse, InitializeResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { createAcpClient, expectErrorCode, initialize } from "./helpers"

describe("opencode acp initialize/auth subprocess", () => {
  cliIt.live(
    "initialize responds with capabilities",
    ({ opencode }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient({ opencode }))

        expect(initialized.protocolVersion).toBe(1)
        expect(initialized.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true)
        expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(true)
        expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true)
        expect(initialized.agentCapabilities?.mcpCapabilities?.sse).toBe(true)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({})
        expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toEqual({})
        expect(initialized.agentCapabilities?.sessionCapabilities?.list).toEqual({})
        expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
        expect(initialized.agentInfo?.name).toBe("Raya") // kilocode_change
      }),
    60_000,
  )

  cliIt.live(
    "auth negotiation is explicit and safe",
    ({ opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient({ opencode })
        const initialized = yield* initialize(acp)

        expect(initialized.authMethods?.[0]).toMatchObject({
          // kilocode_change start
          id: "kilo-login",
          name: "Sign in to Raya",
          description: "Sign in to Raya by running `kilo auth login` in the terminal",
          _meta: {
            "terminal-auth": {
              command: "opencode",
              args: ["auth", "login"],
              label: "Sign in to Raya",
            },
          },
          // kilocode_change end
        })
        expect(yield* acp.request<AuthenticateResponse>("authenticate", { methodId: "kilo-login" })).toMatchObject({
          // kilocode_change
          result: {},
        })

        const rejected = yield* acp.request<AuthenticateResponse>("authenticate", { methodId: "missing-auth-method" })
        expectErrorCode(rejected.error, -32602)
        expect(JSON.stringify(rejected.error)).not.toContain(process.env.KILO_AUTH_CONTENT ?? "not-present")
      }),
    60_000,
  )

  cliIt.live(
    "initialize without terminal-auth metadata keeps auth command implicit",
    ({ opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient({ opencode })
        const initialized = yield* acp.request<InitializeResponse>("initialize", { protocolVersion: 1 })

        expect(initialized.result?.authMethods?.[0]?.id).toBe("kilo-login") // kilocode_change
        expect(initialized.result?.authMethods?.[0]?._meta?.["terminal-auth"]).toBeUndefined()
      }),
    60_000,
  )
})
