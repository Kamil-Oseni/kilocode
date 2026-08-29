// raya_change - global natural-language self-healing feedback command
export type SelfHealCommand =
  | { kind: "usage"; notice: string }
  | { kind: "list" }
  | { kind: "capture"; description: string }

const usage = "Usage: /self-heal <describe the issue you noticed> or /self-heal list"

export function parseSelfHealCommand(text: string): SelfHealCommand | undefined {
  const match = text.trim().match(/^\/self-heal(?:\s+([\s\S]*))?$/i)
  if (!match) return
  const description = match[1]?.trim()
  if (!description) return { kind: "usage", notice: usage }
  if (description.toLowerCase() === "list") return { kind: "list" }
  return { kind: "capture", description }
}

export function selfHealPrompt(input: {
  id: string
  title: string
  description: string
  category: string
  approach: string
}) {
  return `<system-reminder>
This is an isolated Raya self-healing session for feedback item ${input.id}.

Title: ${input.title}
Category: ${input.category}
Report: ${input.description}
Suggested approach: ${input.approach}

Reproduce the report from current evidence, implement the complete repair, and verify it with the smallest authoritative tests plus runtime or visual evidence when relevant. Keep todowrite current. Do not create another self-heal item from this session. Complete the linked goal only when the fix is proven; otherwise block it with the exact reason.
</system-reminder>`
}
