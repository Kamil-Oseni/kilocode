const hidden = new Set(["_noop"])

function names(tools: Iterable<string>) {
  return [...new Set(tools)].filter((name) => !hidden.has(name)).toSorted()
}

export function prompt(tools: Iterable<string>) {
  const list = names(tools)
  if (list.length === 0) {
    return "Current turn tool registry: no tools are available. Do not emit a tool call. Tool names mentioned earlier in the conversation or in general instructions are not available in this turn."
  }
  const route =
    list.length === 1 && list[0] === "chief_route"
      ? " This turn is only for routing the current request. Call chief_route once with objective containing the complete current user request. Set access explicitly to read for inspection, edit for requested file changes, or computer for requested desktop actions. Omitting access does not classify the requested work and never authorizes editing. This work class does not grant permissions. Use its default specialist workflow unless the complete request requires Home Assistant device work. Inspect the routing result before attempting the requested work; file, task and goal tools are unavailable until routing advances the workflow."
      : ""
  const file =
    list.includes("read") && (list.includes("write") || list.includes("edit"))
      ? " Read tool file output is a display: its path/type/content wrappers, numbered line labels such as '1: ', and end-of-file notices are not original file content. When writing or editing, use only the requested file content, not those display labels or wrappers. For an exact copy, use recorded file-format facts and preserve the source's original line endings and final-newline state when known; displayed line separation does not establish those bytes. If the available evidence does not establish exact bytes, do not invent formatting or claim byte-exact verification. Follow the user's requested changes rather than copying unchanged content when an edit was requested."
      : ""
  const task = list.includes("task")
    ? " For a fresh task delegation, provide a nonempty brief.objective or the supported prompt field describing the work to perform. description, subagent_type and access do not supply an objective. Omit the objective only for an actual saved branch_id or task_id resume, or an acknowledged current Chief request or follow-up whose objective is already retained. For a fresh delegation, omit task_id and branch_id unless using an actual saved resume or branch. Never send empty strings for these IDs. Never invent saved IDs or assume a saved objective exists. Carry the selected Chief access into Task. For a fresh delegation without a saved class, set access explicitly to read, edit or computer for the work requested; omission never grants permission to edit. Do not send an edit objective to a read-only specialist. If Task refuses capability before starting a child, refine an omitted legacy Chief class with chief_route using the same complete request and explicit access before retrying Task."
    : ""
  return `Current turn tool registry (authoritative): ${list.join(", ")}. Call only these exact tool names. Tool names mentioned earlier in the conversation or in general instructions do not grant access in this turn.${route}${file}${task}`
}

export function unavailable(name: string, tools: Iterable<string>) {
  const list = names(tools)
  const available = list.length === 0 ? "No tools are available in this turn." : `Available tools: ${list.join(", ")}.`
  return `Tool "${name}" is unavailable in the current turn. ${available} Do not retry the unavailable tool name.`
}

export * as TurnTools from "./turn-tools"
