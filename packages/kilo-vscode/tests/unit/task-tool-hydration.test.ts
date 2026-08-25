import { beforeEach, describe, expect, it } from "bun:test"
import {
  readToolOpen,
  resetToolOpenState,
  toolOpenKey,
  writeToolOpen,
} from "../../../kilo-ui/src/components/tool-open-state"
import { taskAgent, taskResult, taskRunning, taskVisible } from "../../webview-ui/src/components/chat/task-tool-state" // raya_change

describe("completed task hydration", () => {
  beforeEach(() => resetToolOpenState())

  it("opens running tasks and collapses completed tasks by default", () => {
    expect(taskRunning("pending")).toBe(true)
    expect(taskRunning("running")).toBe(true)
    expect(taskRunning("completed")).toBe(false)
    expect(readToolOpen(toolOpenKey({ tool: "task", partID: "part-new" }), taskRunning("completed"))).toBe(false)
  })

  it("keeps expansion state isolated by copied part ID", () => {
    const source = { tool: "task", partID: "part-source", defaultOpen: false }
    const fork = { tool: "task", partID: "part-fork", defaultOpen: false }
    writeToolOpen(toolOpenKey(source), true)

    expect(readToolOpen(toolOpenKey(source), source.defaultOpen)).toBe(true)
    expect(readToolOpen(toolOpenKey(fork), fork.defaultOpen)).toBe(false)
  })

  it("hydrates and streams a child only while expanded", () => {
    expect(taskVisible(false, "ses_child")).toBeUndefined()
    expect(taskVisible(true, "ses_child")).toBe("ses_child")
    expect(taskVisible(true, undefined)).toBeUndefined()
  })

  it("renders the retained result when a fork has no child session", () => {
    const output = "task_id: stale\n\n<task_result>\nchild outcome\n</task_result>"
    expect(taskResult(output, undefined)).toBe("child outcome")
    expect(taskResult(output, "ses_child")).toBeUndefined()
    expect(taskResult("plain output", undefined)).toBe("plain output")
  })

  // raya_change - Milestone D nested threads expose automatic routing and final summaries
  it("labels the live nested thread with the Chief-selected specialist", () => {
    expect(
      taskAgent(
        { description: "Inspect API routes" },
        { selectedAgent: "explore", selection: "auto" },
      ),
    ).toEqual({
      agent: "explore",
      description: "Auto → explore · Inspect API routes",
    })
    expect(taskResult("<task_result>\nSynthesized route map\n</task_result>", undefined)).toBe(
      "Synthesized route map",
    )
    expect(
      taskResult(
        "<task_result>\nSynthesized route map\n</task_result>",
        taskRunning("completed") ? "ses_child" : undefined,
      ),
    ).toBe("Synthesized route map")
  })
})
