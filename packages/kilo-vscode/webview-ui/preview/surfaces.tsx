import { createComponent, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ToolRegistry } from "@kilocode/kilo-ui/message-part"
import HistoryView from "../src/components/history/HistoryView"
import { PromptInput } from "../src/components/chat/PromptInput"
import { SessionReviewCluster } from "../src/components/chat/SessionReviewCluster"
import { registerVscodeToolOverrides } from "../src/components/chat/VscodeToolOverrides"
import { editReview } from "../src/components/chat/edit-review"
import { StoryProviders } from "../src/stories/StoryProviders"
import { SessionContext, useSession } from "../src/context/session"
import { VoiceProvider } from "../src/context/voice"
import { BackgroundAgents } from "../src/components/chat/BackgroundAgents"
import { SubagentViewer } from "../src/components/chat/SubagentViewer"
import { StartupErrorBanner } from "../src/components/chat/StartupErrorBanner"
import { ErrorDisplay } from "../src/components/chat/ErrorDisplay"
import { TurnOutcome } from "../src/components/shared/TurnOutcome"
import { useVSCode } from "../src/context/vscode"
import type { SessionInfo } from "../src/types/messages"

const now = Date.now()
const listed: SessionInfo[] = [
  {
    id: "s1",
    title: "Reskin the composer and goal bar",
    createdAt: new Date(now - 7_200_000).toISOString(),
    updatedAt: new Date(now - 7_200_000).toISOString(),
  },
  {
    id: "s2",
    title: "Inline edit-review chrome",
    createdAt: new Date(now - 18_000_000).toISOString(),
    updatedAt: new Date(now - 18_000_000).toISOString(),
  },
  {
    id: "s3",
    title: "Per-file undo, keep the conversation",
    createdAt: new Date(now - 86_400_000).toISOString(),
    updatedAt: new Date(now - 86_400_000).toISOString(),
  },
  {
    id: "s4",
    title: "Eden token layer for the webview",
    createdAt: new Date(now - 172_800_000).toISOString(),
    updatedAt: new Date(now - 172_800_000).toISOString(),
  },
  {
    id: "s5",
    title: "Bundle Instrument Serif and Outfit offline",
    createdAt: new Date(now - 259_200_000).toISOString(),
    updatedAt: new Date(now - 259_200_000).toISOString(),
  },
]

export function wrap(sessionID: string, child: () => JSX.Element) {
  return createComponent(StoryProviders, {
    sessionID,
    noPadding: true,
    get children() {
      return child()
    },
  })
}

const Sessions: Component<{ children: JSX.Element }> = (props) => {
  const session = useSession()
  const value = {
    ...session,
    sessions: () => listed,
    loadSessions: () => {},
  }
  return createComponent(SessionContext.Provider, {
    value: value as never,
    get children() {
      return props.children
    },
  })
}

const Prompt: Component<{ focus?: boolean }> = (props) => {
  onMount(() => {
    if (!props.focus) return
    document.querySelector<HTMLTextAreaElement>("textarea.prompt-input")?.focus()
  })
  return createComponent(PromptInput, { boxId: "preview" })
}

export const ComposerPreview: Component<{ focus?: boolean }> = (props) =>
  wrap("s1", () =>
    createComponent(VoiceProvider, {
      get children() {
        return createComponent(Prompt, { focus: props.focus })
      },
    }),
  )

export const HistoryPreview: Component = () =>
  wrap("s2", () =>
    createComponent(Sessions, {
      get children() {
        return createComponent(HistoryView, { onSelectSession: () => {} })
      },
    }),
  )

const AgentSession: Component<{ children: JSX.Element }> = (props) => {
  const session = useSession()
  const status = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`child-${index + 1}`, { type: "busy" as const }]),
  )
  const usage = Array.from({ length: 12 }, (_, index) => ({
    sessionID: `child-${index + 1}`,
    steps: index + 1,
    cost: (index + 1) / 100,
    accounting: { amount: (index + 1) / 100, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 0 },
  }))
  const value = {
    ...session,
    allStatusMap: () => status,
    modelUsage: () => ({
      totals: { steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      models: [],
      sessionUsage: usage,
    }),
  }
  return <SessionContext.Provider value={value as never}>{props.children}</SessionContext.Provider>
}

export const BackgroundAgentsPreview: Component = () =>
  wrap("parent", () => (
    <AgentSession>
      <div class="chat-view" style={{ width: "100%" }}>
        <BackgroundAgents />
      </div>
    </AgentSession>
  ))

const ChildViewer: Component = () => {
  const vscode = useVSCode()
  return (
    <SubagentViewer
      target={{
        sessionID: "child-1",
        title: "Review authentication boundaries",
        parentSessionID: "parent",
        parentTitle: "Ship delegated-agent monitoring",
      }}
      sessionTitle="Review authentication boundaries"
      onParentClick={() => vscode.postMessage({ type: "closePanel" })}
    />
  )
}

export const ChildViewerPreview: Component = () =>
  wrap("parent", () => (
    <AgentSession>
      <div style={{ height: "32rem", width: "100%" }}>
        <ChildViewer />
      </div>
    </AgentSession>
  ))

const Outcome: Component<{ reason: "interrupted" | "error"; finish?: string }> = (props) => {
  const session = useSession()
  const value = {
    ...session,
    status: () => "idle",
    closeReason: () => props.reason,
    visibleMessages: () => [
      {
        id: "recovery-assistant",
        sessionID: "recovery",
        role: "assistant",
        time: { created: Date.now() },
        parentID: "recovery-user",
        modelID: "preview",
        providerID: "preview",
        mode: "build",
        path: { cwd: "C:/Workspace", root: "C:/Workspace" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: props.finish,
      },
    ],
    todos: () => [],
    isErrorHidden: () => false,
  }
  return <SessionContext.Provider value={value as never}><TurnOutcome /></SessionContext.Provider>
}

export const RecoveryPreview: Component = () =>
  wrap("recovery", () => (
    <div class="tool-call-lab-stack" data-recovery-preview>
      <section>
        <h2>Connection recovery</h2>
        <StartupErrorBanner
          errorMessage="Failed to start the Raya CLI"
          errorDetails="spawn C:/Raya/bin/kilo.exe ENOENT"
        />
      </section>
      <section>
        <h2>Interrupted work</h2>
        <Outcome reason="interrupted" />
      </section>
      <section>
        <h2>Provider failure</h2>
        <ErrorDisplay
          error={{ name: "UnknownError", data: { message: "Provider request failed before Raya could finish." } }}
        />
        <ErrorDisplay
          error={{
            name: "APIError",
            data: {
              message: "Unauthorized",
              statusCode: 401,
              isRetryable: false,
              responseBody: '{"error":{"code":"PAID_MODEL_AUTH_REQUIRED"}}',
            },
          }}
          onLogin={() => undefined}
        />
      </section>
    </div>
  ))

export const ReviewPreview: Component<{ confirming?: boolean }> = (props) => (
  <div class="session-actions-row">
    <SessionReviewCluster
      files={4}
      additions={128}
      deletions={14}
      pending
      discarding={!!props.confirming}
      reviewing={false}
      idle
      label="Show Changes"
      hint="4 files changed"
      onOpen={() => {}}
      onKeep={() => {}}
      onUndo={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  </div>
)

registerVscodeToolOverrides()

const patch = ToolRegistry.render("apply_patch")
const multi = ToolRegistry.render("multiedit")
if (!patch || !multi) throw new Error("Review tool renderers are unavailable")

export const EditReviewPreview: Component = () => {
  const [request, setRequest] = createSignal("")
  const expected = {
    "src/review/renamed.ts": "rename-v1",
    "src/styles/legacy-composer.css": "delete-v1",
    "src/components/chat/PromptInput.tsx": "edit-v1",
  }
  editReview.update("s2", expected)
  const dispose = editReview.connect("s2", {
    request: (action, file) => setRequest(`${action}:${file}`),
    busy: () => false,
  })
  onCleanup(dispose)

  return wrap("s2", () => (
    <div
      class="chat-view"
      data-review-request={request()}
      style={{ display: "flex", "flex-direction": "column", gap: "12px" }}
    >
      <Dynamic
        component={patch}
        tool="apply_patch"
        status="completed"
        input={{}}
        output="Success. Updated 2 files."
        metadata={{
          files: [
            {
              filePath: "C:/Users/example/project/src/review/old.ts",
              relativePath: "src/review/renamed.ts",
              movePath: "C:/Users/example/project/src/review/renamed.ts",
              type: "move",
              patch: "@@ -1 +1 @@\n-old name\n+new name",
              additions: 1,
              deletions: 1,
            },
            {
              filePath: "C:/Users/example/project/src/styles/legacy-composer.css",
              relativePath: "src/styles/legacy-composer.css",
              type: "delete",
              patch: "@@ -1 +0,0 @@\n-legacy rule",
              additions: 0,
              deletions: 1,
            },
          ],
        }}
      />
      <Dynamic
        component={multi}
        tool="multiedit"
        status="completed"
        input={{}}
        output="Updated src/components/chat/PromptInput.tsx"
        metadata={{
          results: [
            {
              filediff: {
                file: "src/components/chat/PromptInput.tsx",
                status: "modified",
                additions: 1,
                deletions: 1,
              },
            },
          ],
        }}
      />
    </div>
  ))
}
