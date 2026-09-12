import { createComponent, type Component, type JSX } from "solid-js"
import { TaskHeader } from "../src/components/chat/TaskHeader"
import { VscodeUserMessage } from "../src/components/chat/VscodeUserMessage"
import { TranscriptRowView } from "../src/components/chat/TranscriptRow"
import { registerVscodeToolOverrides } from "../src/components/chat/VscodeToolOverrides"
import { SessionContext, useSession } from "../src/context/session"
import { mockSessionValue } from "../src/stories/StoryProviders"
import type { Message, Part } from "../src/types/messages"
import type { TranscriptAssistantRow, TranscriptUserRow } from "../src/context/transcript-rows"
import { wrap } from "./surfaces"

registerVscodeToolOverrides()

const sid = "s3"
const uid = "u1"
const aid = "a1"
const created = new Date().toISOString()
const stamp = Date.now()

const user: Message = {
  id: uid,
  sessionID: sid,
  role: "user",
  createdAt: created,
  time: { created: stamp - 12_000 },
}

const assistant: Message = {
  id: aid,
  sessionID: sid,
  role: "assistant",
  parentID: uid,
  createdAt: created,
  time: { created: stamp - 9_000, completed: stamp - 1_000 },
  modelID: "anthropic/claude-sonnet-4-6",
  providerID: "kilo",
  mode: "default",
  agent: "code",
  path: { cwd: "/project", root: "/project" },
}

const prompt: Part[] = [
  {
    id: "p-user",
    sessionID: sid,
    messageID: uid,
    type: "text",
    text: "/goal Redesign the composer, then run /loop to keep iterating on the preview.",
  },
]

function done(id: string, name: string, input: Record<string, unknown>, title: string, output = ""): Part {
  return {
    id,
    sessionID: sid,
    messageID: aid,
    type: "tool",
    tool: name,
    callID: `${id}-call`,
    state: {
      status: "completed",
      input,
      output,
      title,
    },
  }
}

const thought: Part[] = [
  {
    id: "p-reason",
    sessionID: sid,
    messageID: aid,
    type: "reasoning",
    text: "Weighed the composer focus treatment against the existing prompt chrome.",
    time: { start: stamp - 6_800, end: stamp - 6_200 },
  },
  done("p-edit", "edit", { filePath: "webview-ui/src/styles/prompt-input.css" }, "Edit prompt-input.css"),
  done(
    "p-bash",
    "bash",
    { command: "bun run typecheck", description: "Typecheck" },
    "Run typecheck",
    "Checked 42 files in 1.2s. No errors.",
  ),
]

const turn: Part[] = [
  {
    id: "p-text",
    sessionID: sid,
    messageID: aid,
    type: "text",
    text: "On it. I grouped the routing and goal-bookkeeping steps into a single quiet row so the conversation stays readable, then made the edits.",
  },
  done("p-goal", "get_goal", {}, "Read goal"),
  done("p-agent", "task", { description: "generalist agent" }, "generalist agent"),
  done("p-update", "update_goal", {}, "Update goal"),
  {
    id: "p-reply",
    sessionID: sid,
    messageID: aid,
    type: "text",
    text: "Here's the change to the composer stylesheet.",
  },
  done("p-eden", "edit", { filePath: "webview-ui/src/styles/eden.css" }, "Edit eden.css"),
]

const userRow: TranscriptUserRow = {
  type: "user",
  key: uid,
  turn: uid,
  partial: false,
  queued: false,
  live: false,
  message: user,
  parts: prompt,
  interrupted: false,
  answered: true,
}

function assistantRow(parts: Part[]): TranscriptAssistantRow {
  return {
    type: "assistant",
    key: aid,
    turn: uid,
    partial: false,
    queued: false,
    live: false,
    message: assistant,
    parts,
  }
}

const Header: Component<{ children: JSX.Element }> = (props) => {
  const session = useSession()
  const value = {
    ...session,
    ...mockSessionValue({ id: sid, status: "idle" }),
    messages: () => [user],
    visibleMessages: () => [user],
    currentSession: () => ({
      id: sid,
      title: "Redesign Raya into an editorial system",
      createdAt: created,
      updatedAt: created,
    }),
    costBreakdown: () => [{ label: "Session", cost: 0.42 }],
    contextUsage: () => ({ tokens: 80_000, percentage: 38 }),
  }
  return createComponent(SessionContext.Provider, {
    value: value as never,
    get children() {
      return props.children
    },
  })
}

export const SlashPreview: Component = () =>
  wrap(sid, () => (
    <div class="chat-view">
      <VscodeUserMessage message={user} parts={prompt} />
    </div>
  ))

export const TopNavPreview: Component = () =>
  wrap(sid, () =>
    createComponent(Header, {
      get children() {
        return createComponent(TaskHeader, {})
      },
    }),
  )

export const TranscriptPreview: Component = () =>
  wrap(sid, () => (
    <div class="chat-view">
      <TranscriptRowView row={assistantRow(thought)} />
    </div>
  ))

export const ConversationPreview: Component = () =>
  wrap(sid, () => (
    <div class="chat-view">
      <TranscriptRowView row={userRow} />
      <TranscriptRowView row={assistantRow(turn)} />
    </div>
  ))
