import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { start as startGoal } from "../../src/kilo-provider/goal"
import { parseGoalCommand, goalPrompt } from "../../src/shared/goal"
import {
  getErrorMessage,
  MessageConfirmation,
  runWithMessageConfirmation,
  sameDirectory,
} from "../../src/kilo-provider-utils"

// Execute the production send method without constructing a VS Code host. Only
// editor/session adapters are supplied; request building and error handling are unchanged.
const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const offset = source.indexOf("  private async handleSendMessage(")
const end = source.indexOf("  // raya_change start - Milestone A persistent goal state", offset)
if (offset < 0 || end < 0) throw new Error("Production send method not found")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(offset, end).replace("private async", "async")} })`,
)
const Subject = new Function(
  "startGoal",
  "parseGoalCommand",
  "goalPrompt",
  "getErrorMessage",
  "runWithMessageConfirmation",
  "sameDirectory",
  `return ${code}`,
)(startGoal, parseGoalCommand, goalPrompt, getErrorMessage, runWithMessageConfirmation, sameDirectory) as {
  new (): { handleSendMessage(...args: unknown[]): Promise<void> }
}

test("goal start gates actual prompt dispatch and preserves the submitted draft on unconfirmed outcomes", async () => {
  const requests: { method: string; path: string; directory: string | null; body: Record<string, unknown> }[] = []
  const messages: Record<string, unknown>[] = []
  let mode = "success"
  const state = Object.assign(new Subject(), {
    client: null as ReturnType<typeof createKiloClient> | null,
    connectionGeneration: 0,
    directory: "C:/project",
    ambiguous: false,
    sandboxTransitions: new Map(),
    sandboxKey: () => "scope",
    resolveSession: async () => ({ sid: "session", dir: "C:/project" }),
    startSelfHeal: async () => ({ handled: false }),
    routeSessionDirectory: (): string | null => (state.ambiguous ? null : state.directory),
    getWorkspaceDirectory: (): string => state.directory,
    postMessage: (message: Record<string, unknown>) => messages.push(message),
    gatherEditorContext: async () => {
      if (mode === "later") state.connectionGeneration++
      return undefined
    },
    closedDrafts: new Set(),
    draftSessions: new Map(),
    connectionService: { recordMessageSessionId: () => undefined },
    checkpoints: { get: async () => undefined },
    confirmations: new MessageConfirmation(),
    withRetry: (run: () => Promise<unknown>) => run(),
    opts: {},
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ method: request.method, path: url.pathname, directory: url.searchParams.get("directory"), body })
      if (!url.pathname.endsWith("/goal")) return new Response(null, { status: 204 })
      if (mode === "failure") return Response.json({ message: "Unavailable" }, { status: 503 })
      if (mode === "malformed") return Response.json({})
      if (mode === "replaced") state.connectionGeneration++
      if (mode === "directory") state.directory = "C:/another-project"
      if (mode === "ambiguous") state.ambiguous = true
      if (mode === "client") state.client = createKiloClient({ baseUrl: url.origin })
      return Response.json({
        objective: mode === "mismatch" ? "Another task" : body.objective,
        intent: "saved-intent",
        status: mode === "complete" ? "complete" : "active",
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
      })
    },
  })
  state.client = createKiloClient({ baseUrl: server.url.toString() })
  const files = [{ mime: "text/plain", url: "file:///C:/project/notes.txt", filename: "notes.txt" }]
  const send = () =>
    state.handleSendMessage(
      "/goal Finish the report",
      "message",
      "session",
      "draft",
      "provider",
      "model",
      "auto",
      undefined,
      files,
    )
  try {
    await send()
    expect(requests.map((item) => item.path)).toEqual(["/session/session/goal", "/session/session/prompt_async"])
    expect(requests[0]).toMatchObject({
      method: "POST",
      directory: "C:/project",
      body: { objective: "Finish the report", messageID: "message" },
    })
    expect(requests[1].body).toMatchObject({ model: { providerID: "provider", modelID: "model" }, agent: "auto" })
    expect(requests[1].body.parts).toContainEqual({ type: "file", ...files[0] })
    expect(messages[0]).toMatchObject({ type: "goalState", goal: { intent: "saved-intent" } })
    for (const failure of [
      "failure",
      "malformed",
      "mismatch",
      "complete",
      "replaced",
      "directory",
      "ambiguous",
      "client",
      "later",
    ]) {
      mode = failure
      state.directory = "C:/project"
      state.ambiguous = false
      requests.length = 0
      messages.length = 0
      await send()
      expect(requests.map((item) => item.method)).toEqual(["POST"])
      expect(requests.map((item) => item.path)).toEqual(["/session/session/goal"])
      expect(messages.at(-1)).toMatchObject({
        type: "sendMessageFailed",
        text: "/goal Finish the report",
        messageID: "message",
        sessionID: "session",
        draftID: "draft",
        files,
        error: expect.stringContaining("task was not sent"),
      })
    }
    mode = "success"
    requests.length = 0
    messages.length = 0
    await state.handleSendMessage("Explain this paragraph", "ordinary", "session", "draft")
    expect(requests.map((item) => item.path)).toEqual(["/session/session/prompt_async"])
    expect(messages).toHaveLength(0)
    requests.length = 0
    state.client = null
    await send()
    expect(requests).toHaveLength(0)
    expect(messages.at(-1)).toMatchObject({ type: "sendMessageFailed", files, draftID: "draft" })
  } finally {
    await server.stop(true)
  }
})
