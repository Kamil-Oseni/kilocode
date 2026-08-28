// raya_change - preview mock for the VS Code webview API so components render
// without an extension host or a running backend.
import type { VSCodeAPI } from "../src/types/messages"

export function installMockVsCode() {
  const scope = globalThis as unknown as { acquireVsCodeApi?: () => VSCodeAPI; rayaPreviewMocked?: boolean }
  if (scope.rayaPreviewMocked) return
  scope.rayaPreviewMocked = true
  scope.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      console.info("[raya preview] mock postMessage", message)
      if (message.type !== "requestProjectUsage") return
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "projectUsageLoaded",
              requestID: message.requestID,
              data: {
                range: message.range,
                since: Date.now() - 7 * 86_400_000,
                until: Date.now(),
                timezone: "UTC",
                sessions: 18,
                totals: {
                  steps: 94,
                  cost: 12.4831,
                  tokens: {
                    input: 824_500,
                    output: 126_800,
                    reasoning: 41_200,
                    cache: { read: 1_420_000, write: 88_000 },
                  },
                },
                models: [
                  {
                    providerID: "openai",
                    modelID: "gpt-5.3-codex",
                    steps: 51,
                    cost: 8.992,
                    tokens: {
                      input: 430_000,
                      output: 76_000,
                      reasoning: 31_000,
                      cache: { read: 910_000, write: 48_000 },
                    },
                  },
                  {
                    providerID: "qwen",
                    modelID: "qwen3.8-max",
                    steps: 43,
                    cost: 3.4911,
                    tokens: {
                      input: 394_500,
                      output: 50_800,
                      reasoning: 10_200,
                      cache: { read: 510_000, write: 40_000 },
                    },
                  },
                ],
              },
            },
          }),
        ),
      )
    }, // raya_change - exercise historical usage states without a backend
    getState: () => undefined,
    setState: () => {},
  })
}
