// raya_change - make Qwen media delivery deterministic across local and remote sources
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"

type User = Extract<ModelMessage, { role: "user" }>
type Part = Exclude<User["content"], string>[number]

function source(part: Part) {
  if (part.type === "image") {
    if (typeof part.image === "string") return part.image
    return part.image instanceof URL ? part.image.toString() : undefined
  }
  if (part.type !== "file") return
  return typeof part.data === "string" ? part.data : part.data instanceof URL ? part.data.toString() : undefined
}

function image(part: Part) {
  if (part.type === "image") return true
  return part.type === "file" && part.mediaType.startsWith("image/")
}

function safe(value: string) {
  const match = value.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/]+={0,2})$/i)
  if (!match) return false
  return match[1].length > 0 && match[1].length % 4 === 0
}

function label(part: Part) {
  if (part.type === "file" && part.filename) return `"${part.filename}"`
  return "image attachment"
}

export namespace DashscopeMedia {
  export function targets(model: Provider.Model) {
    const value = [model.providerID, model.id, model.api.id, model.api.url, model.api.npm]
      .map(String)
      .join(" ")
      .toLowerCase()
    return (
      value.includes("qwen") ||
      value.includes("dashscope") ||
      value.includes("aliyuncs.com") ||
      model.api.npm === "@ai-sdk/alibaba"
    )
  }

  export function sanitize(messages: ModelMessage[], model: Provider.Model): ModelMessage[] {
    if (!targets(model)) return messages
    return messages.map((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) return message
      const content = message.content.map((part) => {
        if (!image(part)) return part
        if (!model.capabilities.input.image) {
          return {
            type: "text" as const,
            text: `ERROR: Cannot read ${label(part)} because this Qwen model does not support image input. Inform the user.`,
          }
        }
        const value = source(part)
        if (value === undefined || safe(value)) return part
        return {
          type: "text" as const,
          text: `Image attachment omitted because the Qwen endpoint cannot access its URL. Re-attach ${label(part)} as an inline image.`,
        }
      })
      return { ...message, content } as ModelMessage
    })
  }
}
