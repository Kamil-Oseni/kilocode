import { describe, expect, it } from "bun:test"
import { chiefActivity, chiefReceipt, type ChiefPart } from "../../webview-ui/src/components/chat/chief-activity"

const plan: ChiefPart = {
  id: "plan",
  tool: "chief_plan",
  state: {
    status: "completed",
    input: {
      proposals: [
        { id: "docs", name: "Docs audit", specialist: "researcher" },
        { id: "ux", name: "UX audit", specialist: "designer" },
      ],
    },
    metadata: { requestID: "request", goalCreatedAt: 1 },
  },
}

const task = (id: string, status: string, output?: string): ChiefPart => ({
  id: `task-${id}`,
  tool: "task",
  state: { status, input: { branch_id: id }, output },
})

const inspect = (states: [string, string, boolean][], request = "request"): ChiefPart => ({
  id: `inspect-${request}`,
  tool: "chief_inspect",
  state: {
    status: "completed",
    input: {},
    output: JSON.stringify({ branches: states.map(([id, state, reviewed]) => ({ id, state, reviewed })) }),
    metadata: { requestID: request, goalCreatedAt: 1 },
  },
})

describe("chiefActivity", () => {
  it("shows distinct planned, working, started and report-ready states without inventing liveness", () => {
    expect(chiefActivity(plan, [plan])?.branches.map((item) => item.state)).toEqual(["planned", "planned"])
    expect(chiefActivity(plan, [plan, task("docs", "running")])?.branches.map((item) => item.state)).toEqual([
      "working",
      "planned",
    ])
    expect(
      chiefActivity(plan, [plan, task("docs", "completed", '<task id="child" state="running">')])?.branches[0]?.state,
    ).toBe("started")
    expect(
      chiefActivity(plan, [plan, task("docs", "completed", '<task id="child" state="completed">')])?.branches[0]?.state,
    ).toBe("ready")
  })

  it("uses only a matching inspection and a later review for the active plan", () => {
    const review: ChiefPart = {
      id: "review",
      tool: "chief_review",
      state: { status: "completed", input: { branch_id: "docs" } },
    }
    const stale = inspect(
      [
        ["docs", "completed", true],
        ["ux", "completed", true],
      ],
      "other-request",
    )
    expect(chiefActivity(plan, [plan, stale, review])?.branches[0]?.state).toBe("planned")
    const current = inspect([
      ["docs", "completed", false],
      ["ux", "admitted", false],
    ])
    expect(chiefActivity(plan, [plan, current, review])?.branches.map((item) => item.state)).toEqual([
      "reviewed",
      "started",
    ])
    const tagged: ChiefPart = {
      ...review,
      state: { ...review.state, metadata: { branchID: "docs", requestID: "other-request", goalCreatedAt: 1 } },
    }
    expect(chiefActivity(plan, [plan, current, tagged])?.branches[0]?.state).toBe("ready")
    tagged.state.metadata = { branchID: "docs", requestID: "request", goalCreatedAt: 1 }
    expect(chiefActivity(plan, [plan, current, tagged])?.branches[0]?.state).toBe("reviewed")
    const next: ChiefPart = {
      ...plan,
      id: "next",
      state: { ...plan.state, metadata: { requestID: "next", goalCreatedAt: 2 } },
    }
    expect(chiefActivity(plan, [plan, current, next, review])?.branches[0]?.state).toBe("ready")
  })

  it("uses only a validated child and current session status to show active work", () => {
    const parent = { ...plan, sessionID: "ses_parent" }
    const start: ChiefPart = {
      id: "start",
      sessionID: "ses_parent",
      tool: "task",
      state: {
        status: "completed",
        input: { branch_id: "docs", background: true },
        output: '<task id="ses_child" state="running">\n<summary>Background task started</summary>\n',
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child",
          childMessageID: "msg_child",
          selectedAgent: "researcher",
          background: true,
          requestID: "request",
          goalCreatedAt: 1,
        },
      },
    }
    const parts = [parent, start]
    expect(chiefActivity(parent, parts)?.branches[0]?.state).toBe("started")
    expect(chiefActivity(parent, parts, { ses_child: { type: "busy" } })?.branches[0]?.state).toBe("working")
    expect(chiefActivity(parent, parts, { ses_child: { type: "idle" } })?.branches[0]?.state).toBe("started")
    const wrong = { ...start, state: { ...start.state, metadata: { ...start.state.metadata, requestID: "other" } } }
    expect(chiefActivity(parent, [parent, wrong], { ses_child: { type: "busy" } })?.branches[0]?.state).toBe("started")
  })

  it("keeps unknown, cancelled and failed outcomes distinct and rejects missing plan evidence", () => {
    const current = inspect([
      ["docs", "unknown", false],
      ["ux", "cancelled", false],
    ])
    expect(chiefActivity(plan, [plan, current])?.branches.map((item) => item.state)).toEqual(["unknown", "cancelled"])
    const contradictory = inspect([
      ["docs", "unknown", true],
      ["ux", "failed", true],
    ])
    expect(chiefActivity(plan, [plan, contradictory])?.branches.map((item) => item.state)).toEqual([
      "unknown",
      "failed",
    ])
    expect(chiefActivity(plan, [plan, task("ux", "error")])?.branches[1]?.state).toBe("failed")
    expect(chiefActivity(plan, [current])).toBeUndefined()
    expect(chiefActivity({ ...plan, state: { ...plan.state, status: "error" } }, [plan])).toBeUndefined()
  })

  it("shows saved purpose and access, then only a completed matching report", () => {
    const saved: ChiefPart = {
      ...plan,
      state: {
        ...plan.state,
        input: {
          proposals: [
            {
              id: "docs",
              name: "Docs audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Check the handoff" },
            },
            {
              id: "ux",
              name: "UX audit",
              specialist: "designer",
              access: "edit",
              brief: { objective: "Improve the chat" },
            },
          ],
        },
      },
    }
    const report: ChiefPart = {
      ...inspect([
        ["docs", "completed", false],
        ["ux", "admitted", false],
      ]),
      state: {
        status: "completed",
        output: JSON.stringify({
          branches: [
            { id: "docs", state: "completed", report: "The handoff matches the current source." },
            { id: "ux", state: "admitted", report: "Premature result" },
          ],
        }),
        metadata: { requestID: "request", goalCreatedAt: 1 },
      },
    }
    const branches = chiefActivity(saved, [saved, report])?.branches
    expect(branches?.map((branch) => [branch.objective, branch.access, branch.report])).toEqual([
      ["Check the handoff", "read", "The handoff matches the current source."],
      ["Improve the chat", "edit", undefined],
    ])
  })

  it("keeps isolated edits pending until an exact integration is recorded", () => {
    const saved: ChiefPart = {
      ...plan,
      state: {
        ...plan.state,
        input: {
          proposals: [
            { id: "docs", name: "Docs edit", specialist: "researcher", access: "edit" },
            { id: "ux", name: "UX audit", specialist: "designer", access: "read" },
          ],
        },
      },
    }
    const receipt = (integration?: string): ChiefPart => ({
      ...inspect([
        ["docs", "completed", true],
        ["ux", "completed", true],
      ]),
      state: {
        status: "completed",
        output: JSON.stringify({
          branches: [
            {
              id: "docs",
              state: "completed",
              reviewed: true,
              edits: { digest: "saved" },
              integration,
              report: "Files changed.",
            },
            { id: "ux", state: "completed", reviewed: true, report: "Audit complete." },
          ],
        }),
        metadata: { requestID: "request", goalCreatedAt: 1 },
      },
    })
    expect(chiefActivity(saved, [saved, receipt()])?.branches.map((item) => item.state)).toEqual([
      "pending",
      "reviewed",
    ])
    expect(chiefActivity(saved, [saved, receipt("integrated")])?.branches.map((item) => item.state)).toEqual([
      "reviewed",
      "reviewed",
    ])
    expect(chiefActivity(saved, [saved, receipt("unknown")])?.branches[0]?.state).toBe("unknown")
  })
})

describe("chiefReceipt", () => {
  const saved: ChiefPart = {
    ...plan,
    state: {
      ...plan.state,
      input: {
        proposals: [
          { id: "docs", name: "Docs audit", specialist: "researcher", access: "read" },
          { id: "ux", name: "UX edit", specialist: "designer", access: "edit" },
        ],
      },
    },
  }
  const snapshot = (id: string, docs: string, ux: string, integration?: string): ChiefPart => ({
    id,
    tool: "chief_inspect",
    state: {
      status: "completed",
      output: JSON.stringify({
        branches: [
          { id: "docs", state: docs },
          { id: "ux", state: ux, edits: { digest: "edit" }, integration },
        ],
      }),
      metadata: { requestID: "request", goalCreatedAt: 1 },
    },
  })

  it("shows one saved background start on its task row after hydration", () => {
    const parent = { ...saved, sessionID: "ses_parent" }
    const start: ChiefPart = {
      id: "start",
      callID: "call-task",
      sessionID: "ses_parent",
      tool: "task",
      state: {
        status: "completed",
        input: { branch_id: "docs", background: true },
        output:
          '<task id="ses_child" state="running">\n<summary>Background task started</summary>\n<task_result>Working</task_result>\n</task>',
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child",
          childMessageID: "msg_child",
          selectedAgent: "researcher",
          background: true,
          requestID: "request",
          goalCreatedAt: 1,
        },
      },
    }
    const duplicate = { ...start, id: "duplicate" }
    const parts = [parent, start, duplicate]
    expect(chiefReceipt(start, parts)).toEqual([{ name: "Docs audit", specialist: "researcher", status: "Started" }])
    expect(chiefActivity(parent, parts)?.branches[0]?.child).toBe("ses_child")
    expect(chiefActivity(parent, parts)?.branches[1]?.child).toBeUndefined()
    expect(chiefReceipt(duplicate, parts)).toEqual([])
    expect(chiefReceipt(start, structuredClone(parts))).toEqual(chiefReceipt(start, parts))
    expect(chiefReceipt(start, [parent, { ...start, state: { ...start.state, status: "running" } }])).toBeUndefined()
    expect(chiefReceipt(start, [parent, { ...start, state: { ...start.state, output: "unknown" } }])).toBeUndefined()
  })

  it("refuses starts with stale, missing or substituted Chief identity", () => {
    const parent = { ...saved, sessionID: "ses_parent" }
    const start: ChiefPart = {
      id: "start",
      sessionID: "ses_parent",
      tool: "task",
      state: {
        status: "completed",
        input: { branch_id: "docs", background: true },
        output: '<task id="ses_child" state="running">\n<summary>Background task started</summary>\n',
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child",
          childMessageID: "msg_child",
          selectedAgent: "researcher",
          background: true,
          requestID: "request",
          goalCreatedAt: 1,
        },
      },
    }
    const invalid = [
      { ...start, sessionID: "ses_other" },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, parentSessionId: "ses_other" } } },
      { ...start, state: { ...start.state, input: { branch_id: "ux", background: true } } },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, requestID: "old" } } },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, goalCreatedAt: 2 } } },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, childMessageID: undefined } } },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, selectedAgent: "designer" } } },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, background: false } } },
      { ...start, state: { ...start.state, metadata: { ...start.state.metadata, sessionId: "ses_other" } } },
    ]
    for (const item of invalid) expect(chiefReceipt(item, [parent, item])).toBeUndefined()
    for (const item of invalid) expect(chiefActivity(parent, [parent, item])?.branches[0]?.child).toBeUndefined()
    expect(chiefReceipt(start, [{ ...parent, id: "previous" }, { ...saved, id: "next" }, start])).toBeUndefined()
  })

  it("shows a saved specialist note only when the parent inspects the matching child", () => {
    const parent = { ...saved, sessionID: "ses_parent" }
    const start: ChiefPart = {
      id: "start",
      callID: "call-task",
      sessionID: "ses_parent",
      tool: "task",
      state: {
        status: "completed",
        input: { branch_id: "docs", background: true },
        output: '<task id="ses_child" state="running">\n<summary>Background task started</summary>\n',
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child",
          childMessageID: "msg_child",
          selectedAgent: "researcher",
          background: true,
          requestID: "request",
          goalCreatedAt: 1,
        },
      },
    }
    const note = {
      version: 1,
      id: "note_1",
      branchID: "docs",
      requestID: "request",
      goalCreatedAt: 1,
      taskCallID: "call-task",
      childSessionID: "ses_child",
      childMessageID: "msg_child",
      toolCallID: "call_note",
      text: "Found the source document.",
      at: 1,
      state: "delivered",
    }
    const inspect = (id: string, value = note): ChiefPart => ({
      id,
      sessionID: "ses_parent",
      tool: "chief_inspect",
      state: {
        status: "completed",
        output: JSON.stringify({
          branches: [
            { id: "docs", state: "admitted", notes: [value] },
            { id: "ux", state: "planned" },
          ],
        }),
        metadata: { requestID: "request", goalCreatedAt: 1 },
      },
    })
    const first = inspect("first")
    const repeat = inspect("repeat")
    expect(chiefReceipt(first, [parent, start, first])?.filter((event) => event.message)).toEqual([
      { name: "Docs audit", specialist: "researcher", status: "Message received", message: note.text, noteID: note.id },
    ])
    expect(chiefReceipt(repeat, [parent, start, first, repeat])).toEqual([])
    for (const value of [
      { ...note, branchID: "ux" },
      { ...note, requestID: "old" },
      { ...note, goalCreatedAt: 2 },
      { ...note, taskCallID: "call-other" },
      { ...note, childSessionID: "ses_other" },
      { ...note, childMessageID: "msg_other" },
      { ...note, state: "unknown" },
    ]) {
      const invalid = inspect("invalid", value)
      expect(chiefReceipt(invalid, [parent, start, invalid])?.some((event) => !!event.message)).toBe(false)
    }
    expect(chiefReceipt(first, [parent, first])?.some((event) => !!event.message)).toBe(false)
  })

  it("places only changed specialist states at the matching inspection receipt", () => {
    const first = snapshot("first", "admitted", "planned")
    const second = snapshot("second", "completed", "completed")
    const repeat = snapshot("repeat", "completed", "completed")
    const parts = [saved, first, second, repeat]
    expect(chiefReceipt(first, parts)?.map((event) => [event.name, event.status])).toEqual([["Docs audit", "Working"]])
    expect(chiefReceipt(second, parts)?.map((event) => [event.name, event.status])).toEqual([
      ["Docs audit", "Report ready"],
      ["UX edit", "Changes ready"],
    ])
    expect(chiefReceipt(repeat, parts)).toEqual([])
  })

  it("shows review, integration, unknown and synthesis only after their matching saved receipts", () => {
    const ready = snapshot("ready", "completed", "completed")
    const review: ChiefPart = {
      id: "review",
      tool: "chief_review",
      state: { status: "completed", metadata: { requestID: "request", goalCreatedAt: 1, branchID: "ux" } },
    }
    const repeat = { ...review, id: "repeat" }
    const applied = snapshot("applied", "completed", "completed", "integrated")
    const unknown = snapshot("unknown", "completed", "completed", "unknown")
    const synth: ChiefPart = {
      id: "synth",
      tool: "chief_synthesize",
      state: { status: "completed", metadata: { requestID: "request", goalCreatedAt: 1 } },
    }
    const parts = [saved, ready, review, repeat, applied, unknown, synth]
    expect(chiefReceipt(review, parts)?.map((event) => event.status)).toEqual(["Ready to apply"])
    expect(chiefReceipt(repeat, parts)).toEqual([])
    expect(chiefReceipt(applied, parts)?.map((event) => event.status)).toEqual(["Applied"])
    expect(chiefReceipt(unknown, parts)?.map((event) => event.status)).toEqual(["Apply status unknown"])
    expect(chiefReceipt(synth, parts)?.map((event) => event.status)).toEqual(["Reports combined"])
  })

  it("rejects mismatched, incomplete and malformed receipts without borrowing another plan", () => {
    const current = snapshot("current", "completed", "cancelled")
    const wrong = {
      ...current,
      id: "wrong",
      state: { ...current.state, metadata: { requestID: "other", goalCreatedAt: 1 } },
    }
    const malformed = {
      ...current,
      id: "malformed",
      state: {
        ...current.state,
        output: JSON.stringify({
          branches: [
            { id: "docs", state: "completed" },
            { id: "docs", state: "failed" },
          ],
        }),
      },
    }
    const failed = { ...current, id: "failed", state: { ...current.state, status: "error" } }
    const next = { ...saved, id: "next", state: { ...saved.state, metadata: { requestID: "next", goalCreatedAt: 2 } } }
    const parts = [saved, wrong, malformed, failed, current, next]
    expect(chiefReceipt(wrong, parts)).toBeUndefined()
    expect(chiefReceipt(malformed, parts)).toBeUndefined()
    expect(chiefReceipt(failed, parts)).toBeUndefined()
    expect(chiefReceipt(current, parts)?.map((event) => [event.name, event.status])).toEqual([
      ["Docs audit", "Report ready"],
      ["UX edit", "Stopped"],
    ])
    expect(chiefReceipt(current, [saved, next, current])).toBeUndefined()
  })
})
