// raya_change - preview mock for the VS Code webview API so components render
// without an extension host or a running backend.
import type { VSCodeAPI, WebviewMessage } from "../src/types/messages"

const emit = (data: object) => window.dispatchEvent(new MessageEvent("message", { data }))

const books = {
  id: "routine",
  name: "Books",
  role: "accountant",
  objective: "Review accounts",
  capabilities: ["accounting"],
  schedule: { kind: "manual" },
  enabled: true,
  access: "brief",
}

const legal = {
  id: "legal",
  name: "Counsel",
  role: "counsel",
  objective: "Review contracts",
  capabilities: ["legal"],
  schedule: { kind: "manual" },
  enabled: true,
  access: "brief",
}

const report = {
  id: "rmg_1",
  agentID: books.id,
  kind: "report",
  source: "report:occ1",
  body: `Friday expenses increased in travel. ${"receipts/Q3-close/vendor-travel-".repeat(18)}ledger.pdf`,
  time: 1,
}

const scene = new URLSearchParams(window.location.search).get("scene") ?? "ready"

const reply = (message: WebviewMessage) => {
  if (message.type === "requestProjectUsage") {
    emit({
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
    })
    return
  }
  if (message.type === "routineList") {
    const id = message.requestID
    const view = message.viewID
    if (scene === "loading") {
      emit({ type: "routineState", requestID: id, viewID: view, refreshID: 1, refresh: "loading" })
      return
    }
    if (scene === "error") {
      emit({
        type: "routineState",
        requestID: id,
        viewID: view,
        refreshID: 1,
        refresh: "error",
        error: "The routine list could not be refreshed. Try Refresh routines.",
      })
      return
    }
    if (scene === "empty") {
      emit({ type: "routineState", requestID: id, viewID: view, refreshID: 1, agents: [], templates: [] })
      emit({ type: "routineInbox", requestID: id, viewID: view, refreshID: 1, items: [] })
      emit({ type: "routineState", requestID: id, viewID: view, refreshID: 1, refresh: "complete" })
      return
    }
    emit({
      type: "routineState",
      requestID: id,
      viewID: view,
      refreshID: 1,
      agents: [books, legal],
      templates: [],
    })
    emit({
      type: "routineInbox",
      requestID: id,
      viewID: view,
      refreshID: 1,
      items: [
        {
          agentID: books.id,
          conversationID: "rcv_1",
          name: books.name,
          role: books.role,
          latest: report,
          unread: 1,
          state: "scheduled",
        },
        {
          agentID: legal.id,
          conversationID: "rcv_legal",
          name: legal.name,
          role: legal.role,
          latest: {
            id: "rmg_legal",
            agentID: legal.id,
            kind: "report",
            source: "report:legal1",
            body: "Counsel filed the motion.",
            time: 2,
          },
          unread: 1,
          state: "scheduled",
        },
      ],
    })
    if (scene === "stale") {
      emit({
        type: "routineRuns",
        requestID: id,
        agentID: books.id,
        error: "Recorded history could not be refreshed.",
      })
    }
    emit({
      type: "routineState",
      requestID: id,
      viewID: view,
      refreshID: 1,
      refresh: "complete",
    })
    return
  }
  if (message.type === "routineInboxPage") {
    emit({
      type: "routineInboxPage",
      requestID: message.requestID,
      agentID: message.agentID,
      messages: message.agentID === legal.id ? [] : [report],
    })
  }
}

export function installMockVsCode() {
  const scope = globalThis as unknown as { acquireVsCodeApi?: () => VSCodeAPI; rayaPreviewMocked?: boolean }
  if (scope.rayaPreviewMocked) return
  scope.rayaPreviewMocked = true
  scope.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      console.info("[raya preview] mock postMessage", message)
      queueMicrotask(() => reply(message))
    },
    getState: () => undefined,
    setState: () => {},
  })
}
