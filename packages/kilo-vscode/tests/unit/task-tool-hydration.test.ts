import { beforeEach, describe, expect, it } from "bun:test"
import {
  readToolOpen,
  resetToolOpenState,
  toolOpenKey,
  writeToolOpen,
} from "../../../kilo-ui/src/components/tool-open-state"
import {
  agentIcon,
  taskAccess,
  taskAccessLabel,
  taskAgent,
  taskModel,
  taskResult,
  taskRunning,
  taskSearchText,
  taskStatus,
  taskVisible,
} from "../../webview-ui/src/components/chat/task-tool-state" // raya_change

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

  it("distinguishes a saved background start from a finished child report", () => {
    const started =
      '<task id="ses_child" state="running">\n<task_result>The task is working in the background.</task_result>\n</task>'
    const finished =
      '<task id="ses_child" state="completed">\n<task_result>Audit findings are ready.</task_result>\n</task>'
    expect(taskResult(started, undefined)).toBeUndefined()
    expect(taskStatus("completed", started)).toBe("Started in background")
    const legacy = "task_id: ses_child\nstate: running\n\n<task_result>Task is still running.</task_result>"
    expect(taskResult(legacy, undefined)).toBeUndefined()
    expect(taskStatus("completed", legacy)).toBe("Started in background")
    expect(taskStatus("completed", finished)).toBe("Report ready")
    expect(taskResult(finished, undefined)).toBe("Audit findings are ready.")
    expect(taskStatus("running", undefined)).toBe("Working")
    expect(taskStatus("error", undefined)).toBe("Needs attention")
    expect(taskStatus("completed", '<task id="ses_child" state="completed"></task>')).toBeUndefined()
    expect(taskSearchText({ status: "completed", output: started, title: (agent) => agent })).toMatchObject({
      status: "Started in background",
      result: undefined,
    })
  })

  it("indexes the durable child name and completed report that the task card renders", () => {
    const input = { subagent_type: "explore", description: "Audit search behavior" }
    const part = { selectedAgent: "researcher", displayName: "Search audit" }
    const output = "task_id: private-debug-id\n\n<task_result>\nFound the missing report\n</task_result>"
    const title = (agent: string) => `${agent} Agent`
    const completed = taskSearchText({ status: "completed", input, part, output, child: "ses_child", title })
    expect(completed).toEqual({
      title: "Search audit",
      description: undefined,
      status: "Report ready",
      access: undefined,
      result: "Found the missing report",
    })
    expect(JSON.stringify(completed)).not.toContain("private-debug-id")

    expect(taskSearchText({ status: "running", input, part, output, child: "ses_child", title }).result).toBeUndefined()
    expect(taskSearchText({ status: "completed", input, output, child: "ses_child", title }).title).toBe(
      "explore Agent",
    )
    expect(taskSearchText({ status: "completed", input, output, child: "ses_child", title }).description).toBe(
      "Audit search behavior",
    )
  })

  it("shows only a versioned saved child authority, never a requested or malformed access", () => {
    const title = (agent: string) => `${agent} Agent`
    const read = { "raya.task.authority": { version: 1, access: "read" } }
    const edit = { "raya.task.authority": { version: 1, access: "edit" } }
    const computer = { "raya.task.authority": { version: 1, access: "computer" } }
    expect(taskAccess(read)).toBe("read")
    expect(taskAccess(edit)).toBe("edit")
    expect(taskAccess(computer)).toBe("computer")
    expect(taskAccessLabel(taskAccess(computer)!)).toBe("Desktop tools")
    expect(taskSearchText({ status: "completed", part: computer, title }).access).toBe("computer")
    expect(taskSearchText({ status: "completed", part: read, title }).access).toBe("read")
    expect(taskAccess(undefined, edit)).toBe("edit")
    expect(taskAccess()).toBeUndefined()
    expect(taskAccess({ access: "edit" })).toBeUndefined()
    expect(taskAccess({ "raya.task.authority": { version: 2, access: "read" } })).toBeUndefined()
    expect(taskAccess({ "raya.task.authority": { version: 1, access: "all" } })).toBeUndefined()
    expect(taskAccess({ "raya.task.authority": null }, read)).toBeUndefined()
    expect(
      taskSearchText({ status: "completed", input: { subagent_type: "explore", access: "edit" }, title }).access,
    ).toBeUndefined()
  })

  // raya_change - Milestone D nested threads expose automatic routing and final summaries
  it("labels the live nested thread with the Chief-selected specialist", () => {
    expect(taskAgent({ description: "Inspect API routes" }, { selectedAgent: "explore", selection: "auto" })).toEqual({
      agent: "explore",
      displayName: undefined,
      description: "Inspect API routes",
    })
    expect(
      taskAgent(
        { description: "Inspect API routes" },
        { selectedAgent: "explore", selection: "auto", displayName: "Map API routes · Explore" },
      ),
    ).toEqual({ agent: "explore", displayName: "Map API routes · Explore", description: "Inspect API routes" })
    expect(taskResult("<task_result>\nSynthesized route map\n</task_result>", undefined)).toBe("Synthesized route map")
    expect(
      taskResult(
        "<task_result>\nSynthesized route map\n</task_result>",
        taskRunning("completed") ? "ses_child" : undefined,
      ),
    ).toBe("Synthesized route map")
  })

  it("uses specialist icons only for known routed roles", () => {
    expect(agentIcon("researcher")).toBe("magnifying-glass")
    expect(agentIcon("designer")).toBe("pencil-line")
    expect(agentIcon("engineer")).toBe("code")
    expect(agentIcon("accountant")).toBe("checklist")
    expect(agentIcon("reasoner")).toBe("brain")
    expect(agentIcon("generalist")).toBe("subagent")
    expect(agentIcon("made-up-role")).toBe("subagent")
  })
})

describe("task model provenance", () => {
  const model = { providerID: "fixture", modelID: "worker" }
  const receipt = {
    version: 1,
    stage: "selected",
    model,
    source: "agent-config",
    variantSource: "none",
    capability: "normalized-provider-flag",
  }
  const metadata = { model, provenance: receipt }

  it("keeps model source separate from agent selection and provider execution", () => {
    expect(taskModel({ ...metadata, selection: "auto" })).toBe("Selected fixture/worker from agent configuration")
    expect(taskModel(undefined, metadata)).toBe("Selected fixture/worker from agent configuration")
    expect(
      taskModel({
        ...metadata,
        variant: "deep",
        provenance: { ...receipt, variant: "deep", variantSource: "model-override" },
      }),
    ).toBe("Selected fixture/worker from agent configuration; Variant deep from model override")
  })

  it("does not infer legacy provenance or borrow a different snapshot's model", () => {
    expect(taskModel({ model })).toBe("Model source not recorded")
    expect(taskModel(undefined)).toBe("Model source not recorded")
    expect(taskModel({ provenance: receipt }, metadata)).toBe("Model selection details unavailable")
    expect(taskModel({ ...metadata, provenance: null }, metadata)).toBe("Model selection details unavailable")
    expect(taskModel({ ...metadata, model: { ...model, variant: "different" } })).toBe(
      "Model selection details unavailable",
    )
  })

  it("rejects malformed, future, inconsistent and unsupported receipts", () => {
    for (const value of [
      { version: 2 },
      { source: "__proto__" },
      { source: "quality-winner" },
      { stage: "executed" },
      { capability: "probed" },
      { model: { ...model, modelID: "different" } },
      { variant: "deep", variantSource: "agent-config" },
      { variantSource: "parent" },
      { model: { ...model, modelID: "worker\nforged" } },
    ])
      expect(taskModel({ ...metadata, provenance: { ...receipt, ...value } })).toBe(
        "Model selection details unavailable",
      )
    expect(
      taskModel({ ...metadata, variant: "deep", provenance: { ...receipt, variant: "deep", variantSource: "parent" } }),
    ).toBe("Model selection details unavailable")
  })
})
