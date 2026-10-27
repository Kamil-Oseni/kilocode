import { expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import type { LocalInferenceLoadedMessage } from "../../webview-ui/src/types/messages/extension-messages"

const { KiloProvider } = await import("../../src/KiloProvider")

for (const status of [200, 503])
  for (const kind of ["current", "client", "generation", "directory", "newer", "disposed"] as const)
    it(`actual SDK local inference ${status} respects ${kind} response scope`, async () => {
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<Response>()
      const sent: LocalInferenceLoadedMessage[] = []
      const requests: URL[] = []
      const snapshot = {
        version: 1,
        sessionID: "ses_original",
        epoch: crypto.randomUUID(),
        observedAt: Date.now(),
        requests: [{ messageID: "msg_active", queued: 1, active: 0, since: Date.now() }],
      }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url))
          if (requests.length > 1) return Response.json(snapshot)
          entered.resolve()
          return held.promise
        },
      })
      const workspace = { directory: "C:/original" }
      const state = {
        client: createKiloClient({ baseUrl: server.url.toString() }),
        connectionState: "connected" as const,
        connectionGeneration: 1,
        inference: new Map<string, symbol>(),
        getWorkspaceDirectory: () => workspace.directory,
        postMessage: (message: LocalInferenceLoadedMessage) => sent.push(message),
      }
      const provider = KiloProvider.prototype as unknown as {
        fetchAndSendLocalInference: (this: typeof state, sessionID: string, requestID: string) => Promise<void>
      }
      const pending = provider.fetchAndSendLocalInference.call(state, "ses_original", "old")
      try {
        await entered.promise
        expect(requests[0].pathname).toBe("/kilocode/local-inference")
        expect(requests[0].searchParams.get("sessionID")).toBe("ses_original")
        expect(requests[0].searchParams.get("directory")).toBe("C:/original")
        if (kind === "client") state.client = createKiloClient({ baseUrl: server.url.toString() })
        if (kind === "generation") state.connectionGeneration++
        if (kind === "directory") workspace.directory = "C:/replacement"
        if (kind === "disposed") state.inference.clear()
        if (kind === "newer") await provider.fetchAndSendLocalInference.call(state, "ses_original", "new")
        held.resolve(Response.json(status === 200 ? snapshot : { message: "Unavailable" }, { status }))
        await pending
        expect(state.inference.size).toBe(0)
        if (kind === "current") {
          expect(sent).toHaveLength(1)
          expect(sent[0]).toMatchObject({ type: "localInferenceLoaded", sessionID: "ses_original", requestID: "old" })
          expect(sent[0].snapshot).toEqual(status === 200 ? snapshot : undefined)
          expect(!!sent[0].error).toBe(status !== 200)
          return
        }
        if (kind === "newer") {
          expect(sent).toEqual([
            { type: "localInferenceLoaded", sessionID: "ses_original", requestID: "new", snapshot },
          ])
          return
        }
        expect(sent).toEqual([])
        await provider.fetchAndSendLocalInference.call(state, "ses_original", "fresh")
        expect(sent).toEqual([
          { type: "localInferenceLoaded", sessionID: "ses_original", requestID: "fresh", snapshot },
        ])
      } finally {
        held.resolve(Response.json({}, { status: 503 }))
        await pending
        await server.stop(true)
      }
    })
