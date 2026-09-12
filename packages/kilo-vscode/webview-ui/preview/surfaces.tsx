import { createComponent, onMount, type Component, type JSX } from "solid-js"
import HistoryView from "../src/components/history/HistoryView"
import { PromptInput } from "../src/components/chat/PromptInput"
import { SessionReviewCluster } from "../src/components/chat/SessionReviewCluster"
import { EditReviewChrome } from "../src/components/chat/EditReviewChrome"
import { StoryProviders } from "../src/stories/StoryProviders"
import { SessionContext, useSession } from "../src/context/session"
import { VoiceProvider } from "../src/context/voice"
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

export const EditReviewPreview: Component = () => (
  <div class="chat-view" style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
    <EditReviewChrome status="added" pending nav={{ index: 0, total: 4 }}>
      <p>src/styles/prompt-input.css</p>
    </EditReviewChrome>
    <EditReviewChrome status="modified" pending nav={{ index: 1, total: 4 }}>
      <p>src/components/chat/PromptInput.tsx</p>
    </EditReviewChrome>
    <EditReviewChrome status="renamed" note="Renamed file" pending nav={{ index: 2, total: 4 }}>
      <button type="button" data-slot="edit-review-file" aria-label="Open src/review/rename.ts in the editor">
        src/review/rename.ts
      </button>
    </EditReviewChrome>
    <EditReviewChrome status="deleted" note="Deleted file" pending nav={{ index: 3, total: 4 }}>
      <button type="button" data-slot="edit-review-file" aria-label="Open src/styles/legacy-composer.css in the editor">
        src/styles/legacy-composer.css
      </button>
    </EditReviewChrome>
  </div>
)
