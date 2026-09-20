// raya_change - refuse replacement children when an equivalent failed task is resumable
import { SessionV1 } from "@opencode-ai/core/v1/session"

function fingerprint(input: Record<string, unknown>) {
  return JSON.stringify({
    description: input.description,
    prompt: input.prompt,
    subagent_type: input.subagent_type,
    brief: input.brief,
    step_cap: input.step_cap,
    command: input.command,
  })
}

function repair(error: string) {
  return /(?:tools?\.|input[_ ]schema|function).{0,80}(?:parameters?\.)?type.{0,40}(?:required|must be|expected).{0,20}object|invalid (?:function parameters|tool schema)/i.test(
    error,
  )
}

function rejected(messages: SessionV1.WithParts[], id: string) {
  for (const message of messages.toReversed()) {
    for (const part of message.parts.toReversed()) {
      if (part.type !== "tool" || part.tool !== "task") continue
      const match = part.state.status === "error" ? part.state.error.match(/task_id="([^"]+)"/)?.[1] : undefined
      if (part.state.input.task_id !== id && match !== id) continue
      if (part.state.status !== "error") return false
      return repair(part.state.error)
    }
  }
  return false
}

export namespace TaskRepeat {
  export function failed(
    messages: SessionV1.WithParts[],
    input: Record<string, unknown>,
  ): { id: string; repair: boolean } | undefined {
    const expected = fingerprint(input)
    for (const message of messages.toReversed()) {
      for (const part of message.parts.toReversed()) {
        if (part.type !== "tool" || part.tool !== "task") continue
        if (fingerprint(part.state.input) !== expected) continue
        if (part.state.status !== "error") return undefined
        const match = part.state.error.match(/task_id="([^"]+)"/)
        if (!match?.[1]) return undefined
        return { id: match[1], repair: repair(part.state.error) }
      }
    }
    return undefined
  }

  export function guard(messages: SessionV1.WithParts[], input: Record<string, unknown>): string | undefined {
    if (typeof input.task_id === "string" && rejected(messages, input.task_id)) {
      return `Child ${input.task_id} already failed because the provider rejected the shared tool schema. Do not spawn or resume another child; repair or change the provider/tool contract first.`
    }
    const match = failed(messages, input)
    if (match?.repair) {
      return `Equivalent child ${match.id} already failed because the provider rejected the shared tool schema. Do not spawn or resume another child; repair or change the provider/tool contract first.`
    }
    if (match && input.task_id !== match.id) {
      return `An equivalent task already failed in resumable child ${match.id}. Retry it with task_id="${match.id}" instead of creating a replacement child.`
    }
    return undefined
  }
}
