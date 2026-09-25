import { expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { TaskRepeat } from "@/kilocode/task-repeat"
import { MessageID, PartID, SessionID } from "@/session/schema"

const input = {
  description: "fix deploy",
  prompt: "repair the Vercel configuration",
  subagent_type: "coder",
  step_cap: 12,
}

function history(error: string, stateInput: Record<string, unknown> = input): SessionV1.WithParts[] {
  const sessionID = SessionID.make("ses_parent")
  const messageID = MessageID.make("msg_parent")
  const item: SessionV1.WithParts = {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.make("msg_user"),
      modelID: ModelV2.ID.make("model"),
      providerID: ProviderV2.ID.make("provider"),
      mode: "build",
      agent: "build",
      path: { cwd: "C:/workspace", root: "C:/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1 },
    },
    parts: [
      {
        id: PartID.make("prt_task"),
        sessionID,
        messageID,
        type: "tool",
        callID: "call_task",
        tool: "task",
        state: { status: "error", input: stateInput, error, time: { start: 1, end: 2 } },
      },
    ],
  }
  return [item]
}

test("equivalent failed tasks return the resumable child without matching changed work", () => {
  const messages = history('Transport failed. This task can be resumed with task_id="ses_child".')

  expect(TaskRepeat.failed(messages, input)).toEqual({ id: "ses_child", repair: false })
  expect(TaskRepeat.failed(messages, { ...input, prompt: "repair a different deployment" })).toBeUndefined()
  expect(TaskRepeat.failed(history("failed without a resume receipt"), input)).toBeUndefined()
})

test("provider tool-schema rejection requires contract repair", () => {
  const messages = history(
    'tools.function.parameters.type is required and must be "object". This task can be resumed with task_id="ses_child".',
  )

  expect(TaskRepeat.failed(messages, input)).toEqual({ id: "ses_child", repair: true })
  expect(TaskRepeat.guard(messages, input)).toContain("Do not spawn or resume another child")
  expect(TaskRepeat.guard(messages, { ...input, prompt: "recover after repair", task_id: "ses_child" })).toContain(
    "Do not spawn or resume another child",
  )
})

test("recoverable failures require the existing child and admit its exact resume", () => {
  const messages = history('Transport failed. This task can be resumed with task_id="ses_child".')

  expect(TaskRepeat.guard(messages, input)).toContain('task_id="ses_child"')
  expect(TaskRepeat.guard(messages, { ...input, task_id: "ses_other" })).toContain('task_id="ses_child"')
  expect(TaskRepeat.guard(messages, { ...input, task_id: "ses_child" })).toBeUndefined()
})

test("the latest equivalent outcome releases a previously failed task", () => {
  const failed = history('Transport failed. This task can be resumed with task_id="ses_child".')[0]
  if (!failed) throw new Error("Expected failed task fixture")
  const completed = structuredClone(failed)
  const part = completed.parts[0]
  if (part?.type !== "tool") throw new Error("Expected task tool fixture")
  part.state = {
    status: "completed",
    input: { ...input, task_id: "ses_child" },
    output: "fixed",
    title: "fixed",
    metadata: {},
    time: { start: 3, end: 4 },
  }

  expect(TaskRepeat.failed([failed, completed], input)).toBeUndefined()
})

test("a background completion cannot start overlapping work while its sibling runs", () => {
  const sessionID = SessionID.make("ses_parent")
  const user = {
    info: {
      id: MessageID.make("msg_user"),
      sessionID,
      role: "user" as const,
      agent: "auto",
      model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
      time: { created: 1 },
    },
    parts: [
      {
        id: PartID.make("prt_user"),
        sessionID,
        messageID: MessageID.make("msg_user"),
        type: "text" as const,
        text: "Review two things in parallel",
      },
    ],
  } satisfies SessionV1.WithParts
  const started = history("running")[0]
  if (!started) throw new Error("Expected task fixture")
  const notice: SessionV1.WithParts = structuredClone(user)
  notice.info.id = MessageID.make("msg_notice")
  const text = notice.parts[0]
  if (text?.type !== "text") throw new Error("Expected completion notice")
  text.messageID = notice.info.id
  text.text = '<task id="ses_finished" state="completed">done</task>'
  text.synthetic = true
  const jobs = [
    {
      id: "ses_running",
      type: "task",
      status: "running" as const,
      started_at: 2,
      origins: [{ sessionID, messageID: started.info.id, callID: "call_task" }],
    },
  ]

  expect(TaskRepeat.pending([user, started, notice], jobs, sessionID)).toBe(true)
  expect(TaskRepeat.pending([user, started, notice], jobs, sessionID, "ses_running")).toBe(true)
  expect(TaskRepeat.pending([user, started, notice], jobs, sessionID, "ses_finished")).toBe(false)
  expect(TaskRepeat.pending([user, started], jobs, sessionID)).toBe(false)
  expect(TaskRepeat.pending([user, started, notice], [{ ...jobs[0], status: "completed" }], sessionID)).toBe(false)
  expect(
    TaskRepeat.pending(
      [user, started, notice],
      [{ ...jobs[0], origins: [{ sessionID, messageID: "msg_other", callID: "call_task" }] }],
      sessionID,
    ),
  ).toBe(false)
})

test("a repeated brief reuses its running child receipt without spawning another", () => {
  const user = history("placeholder")[0]!
  user.info = {
    id: MessageID.make("msg_user"),
    sessionID: SessionID.make("ses_parent"),
    role: "user",
    agent: "auto",
    model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
    time: { created: 1 },
  }
  user.parts = [
    {
      id: PartID.make("prt_user"),
      sessionID: SessionID.make("ses_parent"),
      messageID: MessageID.make("msg_user"),
      type: "text",
      text: "Run two independent audits",
    },
  ]
  const started = history("placeholder")[0]!
  const part = started.parts[0]
  if (part?.type !== "tool") throw new Error("Expected task fixture")
  part.state = {
    status: "completed",
    input,
    output: "running",
    title: "fix deploy · Coder",
    metadata: { jobId: "ses_child" },
    time: { start: 2, end: 3 },
  }
  const jobs = [{ id: "ses_child", type: "task", status: "running" as const, started_at: 2 }]
  expect(TaskRepeat.running([user, started], jobs, input)).toMatchObject({ id: "ses_child" })
  expect(TaskRepeat.running([user, started], jobs, { ...input, description: "other work" })).toBeUndefined()
  expect(TaskRepeat.running([user, started], [{ ...jobs[0], status: "completed" }], input)).toBeUndefined()
})
