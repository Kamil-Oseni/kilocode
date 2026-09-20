import { describe, expect, it } from "bun:test"
import { describe as task, repository } from "../../webview-ui/src/components/history/history-task"

const session = {
  id: "ses_task",
  title: "Resume accounting review",
  projectID: "project-fallback",
  directory: "C:/work/finance",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(1).toISOString(),
  summary: { additions: 4, deletions: 1, files: 2 },
}

describe("history task descriptions", () => {
  it("shows the project, meaningful result, status and required action", () => {
    expect(task(session, "waiting", false)).toEqual({
      project: "finance",
      result: "2 files changed",
      status: "Needs your answer",
      action: "Open to respond",
    })
    expect(task(session, "working", false)).toMatchObject({ status: "Working", action: "Open to monitor" })
    expect(task(session, "idle", true)).toMatchObject({ status: "Open here", action: "Continue task" })
    expect(task(session, "idle", false)).toMatchObject({ status: "Ready", action: "Resume task" })
  })

  it("names repository URLs without leaking the transport syntax", () => {
    expect(repository("git@github.com:eden/raya.git")).toBe("raya")
    expect(repository()).toBe("Project metadata unavailable")
  })
})
