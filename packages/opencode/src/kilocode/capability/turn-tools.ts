const hidden = new Set(["_noop"])

function names(tools: Iterable<string>) {
  return [...new Set(tools)].filter((name) => !hidden.has(name)).toSorted()
}

export function prompt(tools: Iterable<string>) {
  const list = names(tools)
  if (list.length === 0) {
    return "Current turn tool registry: no tools are available. Do not emit a tool call. Tool names mentioned earlier in the conversation or in general instructions are not available in this turn."
  }
  return `Current turn tool registry (authoritative): ${list.join(", ")}. Call only these exact tool names. Tool names mentioned earlier in the conversation or in general instructions do not grant access in this turn.`
}

export function unavailable(name: string, tools: Iterable<string>) {
  const list = names(tools)
  const available = list.length === 0 ? "No tools are available in this turn." : `Available tools: ${list.join(", ")}.`
  return `Tool "${name}" is unavailable in the current turn. ${available} Do not retry the unavailable tool name.`
}

export * as TurnTools from "./turn-tools"
