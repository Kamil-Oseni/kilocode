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
