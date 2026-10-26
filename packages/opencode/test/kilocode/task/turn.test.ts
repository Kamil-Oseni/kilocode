import { expect, test } from "bun:test"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RayaChief } from "@/kilocode/chief"
import { assigned, inspected } from "@/kilocode/task/turn"

test("only the current successful organization assignment releases its acknowledgement", () => {
  const request = "Assign this work to my organization"
  const session = {
    id: SessionID.make("ses_assignment"),
    metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "route" },
  }
  const user = MessageID.make("msg_request")
  const assistant = MessageID.make("msg_assignment")
  const model = { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") }
  const input = { organizationID: "org_saved", expectedRevision: 2, senderID: "dispatch", recipientID: "builder" }
  const part = {
    id: PartID.make("prt_assignment"),
    messageID: assistant,
    sessionID: session.id,
    type: "tool" as const,
    tool: "assign_organization_work",
    callID: "assignment",
    state: {
      status: "completed" as const,
      input,
      title: "Organization work assigned",
      output: "Dispatch assigned the work to Builder. Saved state: queued.",
      metadata: {
        requestStatus: "complete",
        delegationID: "work_saved",
        organizationID: input.organizationID,
        organizationRevision: input.expectedRevision,
        senderID: input.senderID,
        recipientID: input.recipientID,
        state: "queued",
      },
      time: { start: 2, end: 3 },
    },
  }
  const messages: MessageV2.WithParts[] = [
    {
      info: { id: user, sessionID: session.id, role: "user", agent: "auto", model, time: { created: 1 } },
      parts: [{ id: PartID.make("prt_request"), messageID: user, sessionID: session.id, type: "text", text: request }],
    },
    {
      info: {
        id: assistant,
        sessionID: session.id,
        role: "assistant",
        parentID: user,
        agent: "auto",
        mode: "auto",
        ...model,
        cost: 0,
        path: { cwd: ".", root: "." },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2 },
      },
      parts: [part],
    },
  ]
  expect(assigned(messages, session, user)).toBe(true)
  expect(assigned(messages, session, "msg_other")).toBe(false)
  expect(assigned(messages, { ...session, parentID: "ses_parent" }, user)).toBe(false)
  expect(assigned(messages, { ...session, metadata: { ...session.metadata, "raya.goal.open": true } }, user)).toBe(
    false,
  )
  for (const state of ["failed", "cancelled", "invented"]) {
    part.state.metadata.state = state
    expect(assigned(messages, session, user)).toBe(false)
  }
  part.state.metadata.state = "queued"
  part.state.metadata.organizationRevision = 3
  expect(assigned(messages, session, user)).toBe(false)
  part.state.metadata.organizationRevision = 2
  part.state.metadata.requestStatus = "unresolved"
  expect(assigned(messages, session, user)).toBe(false)
  part.state.metadata.requestStatus = "complete"
  messages[1].parts.push({
    ...part,
    callID: "later-failure",
    state: { ...part.state, status: "error", error: "failed" },
  })
  expect(assigned(messages, session, user)).toBe(true)
  part.state.metadata.requestStatus = "unresolved"
  expect(assigned(messages, session, user)).toBe(false)
  part.state.metadata.requestStatus = "complete"
  messages[1].parts.push({ ...part, callID: "pending", state: { status: "pending", input, raw: "" } })
  expect(assigned(messages, session, user)).toBe(false)
  messages[1].parts.pop()
  expect(inspected(messages, session, user)).toBe(false)
  const inspection = {
    ...part,
    callID: "inspection",
    tool: "inspect_routines",
    state: {
      ...part.state,
      input: {},
      metadata: { routineCount: 0, organizationCount: 0 },
      title: "Saved routines",
      output: '{"routines":[],"organizations":[]}',
    },
  }
  messages[1].parts.push(inspection)
  expect(inspected(messages, session, user)).toBe(true)
  expect(inspected(messages, session, "msg_other")).toBe(false)
  expect(inspected(messages, { ...session, parentID: "ses_parent" }, user)).toBe(false)
  inspection.state.title = "Routines unavailable"
  expect(inspected(messages, session, user)).toBe(false)
  inspection.state.title = "Saved routines"
  inspection.state.metadata.routineCount = -1
  expect(inspected(messages, session, user)).toBe(false)
  inspection.state.metadata.routineCount = 0
  messages[1].parts.pop()
  messages[1].parts.push({ ...inspection, state: { ...inspection.state, status: "error", error: "Inspection failed" } })
  expect(inspected(messages, session, user)).toBe(false)
})
