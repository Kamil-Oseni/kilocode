import { describe, expect, it } from "bun:test"
import { inventory } from "../../src/shared/connections"

describe("connection overview", () => {
  it("consumes snapshots without exposing credentials or inventing account authority", () => {
    const secret = "private-connection-secret"
    const result = inventory({
      mcp: {
        calendar: {
          type: "remote",
          url: `https://user:${secret}@example.test/private?token=${secret}`,
          headers: { Authorization: secret },
          environment: { TOKEN: secret },
          command: ["program", secret],
          enabled: true,
        },
      },
      collections: { mcp: [{ key: "calendar", source: "project", value: { secret } }] },
      status: { calendar: { status: "connected", error: secret, account: "unverified-account" } },
    })
    expect(result).toEqual({
      version: 1,
      omitted: 0,
      items: [
        {
          version: 1,
          id: "calendar",
          name: "calendar",
          kind: "mcp",
          transport: "remote",
          origin: "project",
          enabled: true,
          status: "connected",
          editable: true,
          removable: true,
          account: "unverified",
          authority: "separate",
          health: "last-received",
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("unverified-account")
    expect(JSON.stringify(result)).not.toContain("example.test")
  })

  it("keeps configured enablement separate from transport and refuses ambiguous management scope", () => {
    const result = inventory({
      mcp: { local: { type: "local", enabled: true }, managed: { type: "remote", enabled: false } },
      collections: {
        mcp: [
          { key: "local", source: "global" },
          { key: "local", source: "project" },
          { key: "managed", source: "system" },
        ],
      },
      status: { local: { status: "disabled" }, managed: { status: "unexpected", error: "private error" } },
    })
    expect(result.items[0]).toMatchObject({
      enabled: true,
      status: "disabled",
      origin: "unknown",
      editable: false,
      removable: false,
    })
    expect(result.items[1]).toMatchObject({
      enabled: false,
      status: "unknown",
      origin: "system",
      editable: false,
      removable: false,
    })
  })

  it("bounds rendered entries and excludes invalid records without silently claiming completeness", () => {
    const mcp = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`server${index}`, { type: "local" }]))
    expect(inventory({ mcp }).items).toHaveLength(200)
    expect(inventory({ mcp }).omitted).toBe(1)
    expect(inventory({ mcp: { invalid: null, ["x".repeat(1025)]: {} } })).toEqual({ version: 1, items: [], omitted: 2 })
    expect(inventory({ mcp: [], collections: null, status: "invalid" })).toEqual({ version: 1, items: [], omitted: 0 })
  })
})
