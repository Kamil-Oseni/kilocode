import { randomBytes } from "node:crypto"

/** One immutable historical context item; it never requests speech or dispatches work. */
export class OpenAIPrefill {
  private readonly id = `raya_context_${randomBytes(12).toString("hex")}`

  constructor(private readonly text: string) {
    if (!text.trim() || Buffer.byteLength(text, "utf8") > 16_384)
      throw new Error("Saved voice context exceeds its allowed size or is empty.")
  }

  create() {
    return {
      type: "conversation.item.create",
      event_id: this.id,
      item: {
        id: this.id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: this.text }],
      },
    }
  }

  receive(event: Record<string, unknown>) {
    if (event.type !== "conversation.item.done" && event.type !== "conversation.item.created") return false
    const item = record(event.item)
    if (item?.id !== this.id) return false
    const content = Array.isArray(item.content) ? item.content : []
    const part = record(content[0])
    if (
      item.type !== "message" ||
      item.role !== "user" ||
      content.length !== 1 ||
      part?.type !== "input_text" ||
      part.text !== this.text
    )
      throw new Error("OpenAI did not confirm the saved task context exactly. Start a new voice call to retry.")
    return true
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
