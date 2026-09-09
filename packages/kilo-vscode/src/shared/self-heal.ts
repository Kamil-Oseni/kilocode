// raya_change - global natural-language self-healing feedback command
export type SelfHealCommand =
  | { kind: "usage"; notice: string }
  | { kind: "list" }
  | { kind: "inspect"; id: string }
  | { kind: "capture"; description: string }

const usage = "Usage: /self-heal <describe the issue you noticed> or /self-heal list or /self-heal inspect <itemID>"

export function parseSelfHealCommand(text: string): SelfHealCommand | undefined {
  const match = text.trim().match(/^\/self-heal(?:\s+([\s\S]*))?$/i)
  if (!match) return
  const description = match[1]?.trim()
  if (!description) return { kind: "usage", notice: usage }
  if (description.toLowerCase() === "list") return { kind: "list" }
  if (/^inspect(?:\s|$)/i.test(description)) {
    const id = description.match(/^inspect\s+(heal_[a-z0-9_-]+)$/i)?.[1]
    return id ? { kind: "inspect", id } : { kind: "usage", notice: usage }
  }
  return { kind: "capture", description }
}

export function selfHealPrompt(input: {
  id: string
  title: string
  description: string
  category: string
  severity?: string
  approach: string
}) {
  return `<system-reminder>
This is a Raya source-repair session for feedback item ${input.id}.

Title: ${input.title}
Category: ${input.category}${input.severity ? `\nSeverity: ${input.severity}` : ""}
Report: ${input.description}
Suggested approach: ${input.approach}

The category, severity, and approach above come from a fast keyword classifier and may be rough. Your FIRST action is to call refine_self_heal to reconcile them: after reading the report, pass your best category, severity, approach, and title. The tool returns the other open backlog items — if this report clearly duplicates one, call refine_self_heal again with duplicateOf set to that item's id and stop (the canonical item owns the fix). Only reconcile once; do not loop on it.

Then reproduce the report from current evidence, implement the complete repair, and verify it with the smallest authoritative tests plus runtime or visual evidence when relevant. Keep todowrite current. Do not create another self-heal item from this session. Complete the linked goal only when the fix is proven; otherwise block it with the exact reason.

Use self_heal_verify for source-bound checks: it captures the owned repair source and runs the check in a private writable copy. Supply dependency setup explicitly when needed; ignored dependencies and credentials are not copied. Cite the returned verification call in the completion audit. This records the captured input, not execution confinement or a released/installed artifact. Ordinary shell, browser and manual evidence retain unknown delivery source identity. If verification is interrupted, inspect the original invocation with self_heal_verify action=inspect, messageID and callID; inspection never repeats the command.
</system-reminder>`
}
