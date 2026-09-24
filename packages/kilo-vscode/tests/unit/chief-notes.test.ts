import { describe, expect, it } from "bun:test"
import { chiefNotesData, chiefNotesPlan, chiefUnseenNotes } from "../../webview-ui/src/components/chat/chief-notes"
import type { ChiefPart } from "../../webview-ui/src/components/chat/chief-activity"

const plan: ChiefPart = {
  id: "plan",
  sessionID: "parent",
  tool: "chief_plan",
  state: { status: "completed", metadata: { goalCreatedAt: 12, requestID: "request", revision: "revision" } },
}
const note = {
  version: 1,
  id: "reply:call",
  branchID: "audit",
  branchName: "Safety audit",
  childSessionID: "child",
  text: "Checking the boundary.",
  at: 20,
  state: "delivered",
}
const response = {
  version: 1,
  sessionID: "parent",
  goalCreatedAt: 12,
  requestID: "request",
  revision: "revision",
  notes: [note],
}

describe("Chief note hydration", () => {
  it("requires a saved exact plan identity and rejects stale responses", () => {
    const identity = chiefNotesPlan("parent", [plan])!
    expect(identity).toEqual({ sessionID: "parent", goalCreatedAt: 12, requestID: "request", revision: "revision" })
    expect(chiefNotesPlan("other", [plan])).toBeUndefined()
    expect(chiefNotesData(response, identity)?.notes).toHaveLength(1)
    expect(chiefNotesData({ ...response, revision: "stale" }, identity)).toBeUndefined()
    expect(chiefNotesData({ ...response, requestID: "other" }, identity)).toBeUndefined()
    expect(chiefNotesData({ ...response, notes: [note, note] }, identity)).toBeUndefined()
    expect(chiefNotesData(response, { ...identity, sessionID: "other" })).toBeUndefined()
  })

  it("hides a saved note after a matching inspection already rendered it", () => {
    const identity = chiefNotesPlan("parent", [plan])!
    const data = chiefNotesData(response, identity)!
    const inspect: ChiefPart = {
      id: "inspect",
      tool: "chief_inspect",
      state: {
        status: "completed",
        metadata: { goalCreatedAt: 12, requestID: "request" },
        output: JSON.stringify({
          branches: [{ id: "audit", notes: [{ ...note, goalCreatedAt: 12, requestID: "request" }] }],
        }),
      },
    }
    expect(chiefUnseenNotes(data, [plan])).toEqual(data.notes)
    expect(chiefUnseenNotes(data, [plan, inspect])).toEqual([])
    expect(
      chiefUnseenNotes(data, [
        plan,
        { ...inspect, state: { ...inspect.state, metadata: { goalCreatedAt: 12, requestID: "other" } } },
      ]),
    ).toEqual(data.notes)
    expect(
      chiefUnseenNotes(data, [
        plan,
        {
          ...inspect,
          state: {
            ...inspect.state,
            output: JSON.stringify({
              branches: [{ id: "other", notes: [{ ...note, goalCreatedAt: 12, requestID: "request" }] }],
            }),
          },
        },
      ]),
    ).toEqual(data.notes)
    expect(
      chiefUnseenNotes(data, [
        plan,
        {
          ...inspect,
          state: {
            ...inspect.state,
            output: JSON.stringify({
              branches: [
                { id: "audit", notes: [{ ...note, text: "Changed", goalCreatedAt: 12, requestID: "request" }] },
              ],
            }),
          },
        },
      ]),
    ).toEqual(data.notes)
  })
})
