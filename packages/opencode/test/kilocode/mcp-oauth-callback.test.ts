import { describe, expect, test, afterEach } from "bun:test"
import { createServer } from "http"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"

describe("Raya MCP OAuth callback", () => {
  afterEach(async () => {
    await McpOAuthCallback.stop()
  })

  test("fails fast when the callback port belongs to another process", async () => {
    const blocker = createServer((_req, res) => {
      res.writeHead(200)
      res.end("occupied")
    })

    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject)
      blocker.listen(0, "127.0.0.1", resolve)
    })

    try {
      const address = blocker.address()
      if (!address || typeof address === "string") throw new Error("missing blocker address")

      await expect(
        McpOAuthCallback.ensureRunning(`http://127.0.0.1:${address.port}/mcp/oauth/callback`),
      ).rejects.toThrow(
        `OAuth callback port ${address.port} is already in use. Close the other Raya process or configure a different MCP OAuth redirect URI, then retry.`,
      )
      expect(McpOAuthCallback.isRunning()).toBe(false)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
