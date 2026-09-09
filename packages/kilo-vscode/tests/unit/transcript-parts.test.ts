import { describe, expect, it } from "bun:test"
import path from "node:path"

const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")
const WORKER_URL = path.resolve(import.meta.dir, "../setup/worker-url.ts")
const PASS = "TRANSCRIPT_PARTS_PASS"
const FAIL = "TRANSCRIPT_PARTS_FAIL:"
// Cold browser-module imports can exceed Bun's five-second default on Windows.
const timeout = 30_000

const SCRIPT = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.CustomEvent = window.CustomEvent

  const { isRenderable } = await import("./src/utils/transcript-parts.ts")
  const message = { id: "message-1", role: "assistant", time: { created: 1, completed: 2 } }
  const parts = [
    { id: "step-finish", type: "step-finish", reason: "stop" },
    { id: "empty-text", type: "text", text: "   " },
    { id: "synthetic-text", type: "text", text: "Synthetic", synthetic: true },
    { id: "visible-text", type: "text", text: "Visible transcript text" },
    { id: "redacted-reasoning", type: "reasoning", text: "[REDACTED]" },
    { id: "visible-reasoning", type: "reasoning", text: "Inspect the implementation" },
    { id: "todo-pending", type: "tool", tool: "todowrite", state: { status: "pending", input: {} } },
    {
      id: "todo-completed",
      type: "tool",
      tool: "todowrite",
      state: { status: "completed", input: {}, output: "done", title: "Updated todos" },
    },
    { id: "read-running", type: "tool", tool: "read", state: { status: "running", input: {} } },
    { id: "memory-running", type: "tool", tool: "kilo_memory_recall", state: { status: "running", input: {} } },
    {
      id: "memory-completed",
      type: "tool",
      tool: "kilo_memory_recall",
      state: { status: "completed", input: {}, output: "memory", title: "Memory recalled" },
    },
  ]
  const visible = parts.filter((part) => isRenderable(part, message)).map((part) => part.id)

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }
  const expected = [
    "visible-text",
    "visible-reasoning",
    "todo-completed",
    "read-running",
    "memory-running",
    "memory-completed",
  ]
  if (visible.length !== expected.length || visible.some((id, index) => id !== expected[index])) {
    fail("did not exclude transcript-invisible parts")
  }
  console.log("${PASS}")
`

// raya_change start - cross-message tool bundling (progressive disclosure #8).
const COALESCE_PASS = "COALESCE_PASS"
const COALESCE_FAIL = "COALESCE_FAIL:"
const COALESCE_SCRIPT = `
  import { Window } from "happy-dom"
  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.CustomEvent = window.CustomEvent

  const { coalesceToolRows } = await import("./src/utils/transcript-parts.ts")

  const time = { created: 1, completed: 2 }
  const tool = (id, name) => ({ id, type: "tool", tool: name, state: { status: "completed", input: {}, output: "ok", title: name } })
  const text = (id, value) => ({ id, type: "text", text: value })

  // One Auto turn spread across separate assistant messages: routing + delegation
  // + goal bookkeeping are tool-only (bundlable) and must collapse together; the
  // final message carries assistant text and must break the run and stand alone.
  const store = {
    "m1": [tool("t1", "chief_route")],
    "m2": [tool("t2", "task")],
    "m3": [tool("t3", "get_goal"), tool("t4", "update_goal")],
    "m4": [text("t5", "Here is the summary.")],
  }
  const messages = ["m1", "m2", "m3", "m4"].map((id) => ({ id, role: "assistant", time }))
  const rows = coalesceToolRows(messages, (m) => store[m.id] ?? [])

  const fail = (reason) => { console.log("${COALESCE_FAIL}" + reason); process.exit(2) }

  // Expect two rows: [collapsed m1+m2+m3 tool run] then [m4 text, standalone].
  if (rows.length !== 2) fail("expected 2 rows, got " + rows.length)
  if (rows[0].message.id !== "m1") fail("run should key off first message")
  if (!rows[0].parts || rows[0].parts.length !== 4) fail("collapsed run should carry all 4 tool parts, got " + (rows[0].parts?.length ?? 0))
  if (rows[1].message.id !== "m4") fail("text message should be its own row")
  if (rows[1].parts !== undefined) fail("standalone message must not override parts")

  // A lone tool-only message stays a solo row (no parts override) so within-message
  // rendering is unchanged; nothing to collapse across a single message.
  const solo = coalesceToolRows([{ id: "s1", role: "assistant", time }], () => [tool("s", "read")])
  if (solo.length !== 1 || solo[0].parts !== undefined) fail("single tool message must not be coalesced")

  // An edit is prominent: it must break the run and never be swept into a group.
  const withEdit = {
    "e1": [tool("e1a", "get_goal")],
    "e2": [{ id: "e2a", type: "tool", tool: "edit", state: { status: "completed", input: {}, output: "ok", title: "edit" } }],
  }
  const editRows = coalesceToolRows(["e1", "e2"].map((id) => ({ id, role: "assistant", time })), (m) => withEdit[m.id] ?? [])
  if (editRows.length !== 2 || editRows[0].parts !== undefined || editRows[1].parts !== undefined) {
    fail("prominent edit must not merge with adjacent tool-only message")
  }

  console.log("${COALESCE_PASS}")
`

describe("transcript parts", () => {
  it("keeps timeline candidates aligned with visible transcript parts", () => {
    const result = Bun.spawnSync(["bun", "--preload", WORKER_URL, "--conditions=browser", "-e", SCRIPT], {
      cwd: WEBVIEW,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const output = result.stdout.toString() + result.stderr.toString()

    if (output.includes(PASS)) return
    const index = output.indexOf(FAIL)
    if (index !== -1) {
      expect.unreachable(
        output
          .slice(index + FAIL.length)
          .split("\n")[0]
          ?.trim(),
      )
    }
    expect.unreachable(`transcript parts test exited ${result.exitCode}: ${output.trim()}`)
  }, timeout)

  it("collapses a run of tool-only messages and leaves prominent parts inline", () => {
    const result = Bun.spawnSync(["bun", "--preload", WORKER_URL, "--conditions=browser", "-e", COALESCE_SCRIPT], {
      cwd: WEBVIEW,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const output = result.stdout.toString() + result.stderr.toString()

    if (output.includes(COALESCE_PASS)) return
    const index = output.indexOf(COALESCE_FAIL)
    if (index !== -1) {
      expect.unreachable(
        output
          .slice(index + COALESCE_FAIL.length)
          .split("\n")[0]
          ?.trim(),
      )
    }
    expect.unreachable(`coalesce test exited ${result.exitCode}: ${output.trim()}`)
  }, timeout)
})
// raya_change end
