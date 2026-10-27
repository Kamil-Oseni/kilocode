import { expect, test } from "bun:test"
import { WorkerHints } from "../../src/kilo-provider/worker-inference-hints"
import { invalidation } from "../../src/kilo-provider/local-inference-event"
import type { ExtensionMessage } from "../../webview-ui/src/types/messages"

const { KiloProvider } = await import("../../src/KiloProvider")
type Host = {
  connectionState: string
  workerHints: WorkerHints
  sessionDirectories: Map<string, string>
  getWorkspaceDirectory: () => string
  postMessage: (message: ExtensionMessage) => void
  workerInferenceHint: (event: unknown, directory?: string) => string | undefined
  inferenceHint: (event: unknown, directory?: string) => string | undefined
}
const provider = KiloProvider.prototype as unknown as {
  inferenceHint: (this: Host, event: unknown, directory?: string) => string | undefined
  workerInferenceHint: (this: Host, event: unknown, directory?: string) => string | undefined
  handleEvent: (this: Host, event: unknown, directory?: string) => void
}

test("inference hints use exact workspace routes without adopting a child or trusting push state", () => {
  const sent: ExtensionMessage[] = []
  const routes = new Map([["ses_known", "C:/known"]])
  const state: Host = {
    connectionState: "connected",
    workerHints: new WorkerHints(),
    sessionDirectories: routes,
    getWorkspaceDirectory: () => "C:/current",
    postMessage: (message) => sent.push(message),
    inferenceHint: provider.inferenceHint,
    workerInferenceHint: provider.workerInferenceHint,
  }
  const hint = (sessionID: string) => ({
    type: "session.inference.changed",
    properties: { sessionID, queued: 99, body: "Untrusted" },
  })
  provider.handleEvent.call(state, hint("ses_known"), "C:/known")
  provider.handleEvent.call(state, hint("ses_child"), "C:/current")
  expect(sent).toEqual([
    { type: "localInferenceChanged", sessionID: "ses_known" },
    { type: "localInferenceChanged", sessionID: "ses_child" },
  ])
  expect([...routes]).toEqual([["ses_known", "C:/known"]])
  for (const [event, directory] of [
    [hint("ses_known"), "C:/current"],
    [hint("ses_child"), "C:/foreign"],
    [hint("ses_child"), "C:/current/subtree"],
    [hint("ses_child"), undefined],
    [hint("ses_child"), "global"],
    [hint("x".repeat(257)), "C:/current"],
    [hint("../foreign"), "C:/current"],
    [{ type: "session.inference.changed", properties: {} }, "C:/current"],
  ] as const) {
    expect(invalidation(event, directory, { connected: true, directory: "C:/current", routes })).toBeUndefined()
    provider.handleEvent.call(state, event, directory)
  }
  state.connectionState = "reconnecting"
  provider.handleEvent.call(state, hint("ses_child"), "C:/current")
  expect(sent).toHaveLength(2)
})
