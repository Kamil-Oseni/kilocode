import { PART_MAPPING, ToolRegistry } from "@kilocode/kilo-ui/message-part"
import type { AssistantMessage, Part } from "@kilocode/sdk/v2"
import { snapshotProgress } from "../context/session-utils"

export const UPSTREAM_SUPPRESSED_TOOLS = new Set(["todowrite", "todoread"])

// raya_change start - progressive disclosure. Tools that must always stay inline
// and un-bundled: they carry their own prominent UI (assistant text/reasoning,
// file edits with inline review chrome, terminal output, plan hand-offs, and any
// active question/suggestion). Everything else (get_goal, update_goal, subagent
// tasks, read/grep/glob/list, etc.) is "meta/read" chatter that collapses into an
// inline "N steps" group. Shared by AssistantMessage (within a message) and
// VscodeSessionTurn (across consecutive tool-only messages in one turn).
export const PROMINENT_TOOLS = new Set([
  "question",
  "ask_options",
  "suggest",
  "bash",
  "plan_exit",
  "write",
  "edit",
  "apply_patch",
  "multiedit",
  "patch",
])

// A renderable part that collapses into an inline tool group. Only meta/read tool
// calls qualify; prominent tools and non-tool parts (text/reasoning) never bundle.
export function bundlableTool(part: Part): boolean {
  if (part.type !== "tool") return false
  if (PROMINENT_TOOLS.has(part.tool)) return false
  if (UPSTREAM_SUPPRESSED_TOOLS.has(part.tool)) return false
  return true
}

export type CoalescedRow<M> = { key: string; message: M; parts?: Part[] }

// Coalesce a run of consecutive assistant messages whose renderable parts are ALL
// bundlable tool calls into a single row (carrying the combined parts), so the
// within-message tool grouping collapses the whole run into one inline "N steps"
// group. Messages carrying any prominent part (text, reasoning, edit, bash,
// question) break the run and render on their own with no parts override. Pure so
// it can be unit-tested independently of the Solid render tree; VscodeSessionTurn
// passes the live store lookup as `partsOf`.
export function coalesceToolRows<M extends AssistantMessage>(
  messages: readonly M[],
  partsOf: (message: M) => readonly Part[],
): CoalescedRow<M>[] {
  const renderable = (m: M) => partsOf(m).filter((part) => isRenderable(part, m))
  const coalescible = (m: M) => {
    const ps = renderable(m)
    return ps.length > 0 && ps.every(bundlableTool)
  }
  const out: CoalescedRow<M>[] = []
  let run: M[] = []
  const flush = () => {
    if (run.length === 0) return
    if (run.length === 1) out.push({ key: run[0]!.id, message: run[0]! })
    else out.push({ key: run[0]!.id, message: run[0]!, parts: run.flatMap(renderable) })
    run = []
  }
  for (const m of messages) {
    if (coalescible(m)) {
      run.push(m)
      continue
    }
    flush()
    out.push({ key: m.id, message: m })
  }
  flush()
  return out
}
// raya_change end

export function isRenderable(part: Part, message: AssistantMessage): boolean {
  if (part.type === "tool") {
    if (UPSTREAM_SUPPRESSED_TOOLS.has(part.tool)) {
      return part.state.status === "completed" && !!ToolRegistry.render(part.tool)
    }
    return true
  }
  if (part.type === "text") {
    return !snapshotProgress(part) && !!part.text?.trim() && !(part.synthetic && message?.time.completed)
  }
  if (part.type === "reasoning") return !!part.text?.replace("[REDACTED]", "").trim()
  return !!PART_MAPPING[part.type]
}
