import { describe, expect, it } from "bun:test"
import { chiefActivity, type ChiefPart } from "../../webview-ui/src/components/chat/chief-activity"

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
  it("shows distinct planned, working and report-ready states without treating a background start as completion", () => {
    expect(chiefActivity(plan, [plan])?.branches.map((item) => item.state)).toEqual(["planned", "planned"])
    expect(chiefActivity(plan, [plan, task("docs", "running")])?.branches.map((item) => item.state)).toEqual([
      "working",
      "planned",
    ])
    expect(
      chiefActivity(plan, [plan, task("docs", "completed", '<task id="child" state="running">')])?.branches[0]?.state,
    ).toBe("working")
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
      "working",
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
})
