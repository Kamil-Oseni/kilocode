import { describe, expect, it } from "bun:test"
import { loadAgentView, saveAgentView } from "../../webview-ui/src/components/chat/background-agent-state"

describe("background agent view state", () => {
  it("persists disclosure and dismissed rows per parent without replacing other webview state", () => {
    const first = saveAgentView({ routineInbox: { selected: "routine" } }, "parent-a", {
      open: true,
      hidden: ["job-a"],
    })
    const second = saveAgentView(first, "parent-b", { open: false, hidden: ["job-b"] })

    expect(loadAgentView(second, "parent-a")).toEqual({ open: true, hidden: ["job-a"] })
    expect(loadAgentView(second, "parent-b")).toEqual({ open: false, hidden: ["job-b"] })
    expect(second.routineInbox).toEqual({ selected: "routine" })
  })

  it("rejects malformed and future state instead of inventing a selection", () => {
    expect(loadAgentView(undefined, "parent")).toEqual({ open: false, hidden: [] })
    expect(loadAgentView({ rayaBackgroundAgents: { version: 2, parents: {} } }, "parent")).toEqual({
      open: false,
      hidden: [],
    })
    expect(
      loadAgentView(
        { rayaBackgroundAgents: { version: 1, parents: { parent: { open: true, hidden: [4], updatedAt: 1 } } } },
        "parent",
      ),
    ).toEqual({ open: false, hidden: [] })
  })

  it("deduplicates and bounds retained parents and dismissed jobs", () => {
    const jobs = Array.from({ length: 120 }, (_, index) => `job-${index}`)
    const withJobs = saveAgentView({}, "parent-0", { open: true, hidden: [...jobs, "job-119"] }, 0)
    const state = Array.from({ length: 60 }, (_, index) => index + 1).reduce(
      (current, index) => saveAgentView(current, `parent-${index}`, { open: index === 60, hidden: [] }, index),
      withJobs,
    )

    expect(loadAgentView(withJobs, "parent-0").hidden).toHaveLength(100)
    expect(loadAgentView(state, "parent-0")).toEqual({ open: false, hidden: [] })
    expect(loadAgentView(state, "parent-60")).toEqual({ open: true, hidden: [] })
  })
})
