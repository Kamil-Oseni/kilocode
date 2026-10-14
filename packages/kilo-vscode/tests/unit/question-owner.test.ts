import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import {
  fetchAndSendPendingQuestions,
  handleQuestionReject,
  handleQuestionReply,
  type QuestionContext,
} from "../../src/kilo-provider/handlers/question"

// The SDK and held HTTP body are real; only the host's route bookkeeping is supplied locally.
for (const row of [
  { action: "list", status: 200, pending: true },
  { action: "list", status: 200, pending: false },
  { action: "reply", status: 200 },
  { action: "reply", status: 404 },
  { action: "reject", status: 200 },
  { action: "reject", status: 404 },
] as const) {
  test(`retired Ask owner ignores held ${row.action} HTTP ${row.status} without successor mutation`, async () => {
    const held = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const requests: string[] = []
    const messages: unknown[] = []
    const routes = new Map([["original", "original-directory"]])
    const state = { generation: 1, revision: 0, pruned: 0 }
    const generation = state.generation
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Basic ${btoa("kilo:synthetic-only")}`)
        requests.push(new URL(request.url).pathname)
        started.resolve()
        await held.promise
        if (row.status === 404) return Response.json({ name: "NotFoundError" }, { status: 404 })
        if (row.action !== "list") return Response.json(true)
        return Response.json(
          row.pending ? [{ id: "original", sessionID: "session", questions: [], blocking: false }] : [],
        )
      },
    })
    const ctx: QuestionContext = {
      client: createKiloClient({
        baseUrl: server.url.toString(),
        headers: { Authorization: `Basic ${btoa("kilo:synthetic-only")}` },
      }),
      current: () => state.generation === generation,
      currentSessionId: "session",
      trackedSessionIds: new Set(["session"]),
      sessionDirectories: new Map(),
      postMessage: (message) => messages.push(message),
      getWorkspaceDirectory: () => "workspace",
      recordQuestionDirectory: (id, directory) => routes.set(id, directory),
      getQuestionDirectory: (id) => routes.get(id),
      clearQuestionDirectory: (id) => void routes.delete(id),
      getQuestionRevision: () => state.revision,
      pruneQuestionDirectories: () => {
        state.pruned++
        routes.clear()
      },
    }
    const work =
      row.action === "list"
        ? fetchAndSendPendingQuestions(ctx)
        : row.action === "reply"
          ? handleQuestionReply(ctx, "original", [["Continue"]], "session")
          : handleQuestionReject(ctx, "original", "session")
    try {
      await started.promise
      state.generation++
      state.revision++
      routes.set("original", "successor-directory")
      routes.set("successor", "workspace")
      held.resolve()
      expect(await work).toBe(row.action === "list" ? undefined : false)
      expect(requests).toHaveLength(1)
      expect(messages).toEqual([])
      expect(state.pruned).toBe(0)
      expect([...routes]).toEqual([
        ["original", "successor-directory"],
        ["successor", "workspace"],
      ])
    } finally {
      held.resolve()
      await work
      await server.stop(true)
    }
  })
}
