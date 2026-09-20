// raya_change - validate reconstructed history before provider dispatch without logging message content
import {
  assistantModelMessageSchema,
  modelMessageSchema,
  systemModelMessageSchema,
  toolModelMessageSchema,
  userModelMessageSchema,
  type ModelMessage,
} from "ai"

type Repair = {
  path: string
  role: string
  action: "metadata-stripped" | "message-dropped"
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean)
  if (!value || typeof value !== "object") return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "providerOptions")
      .map(([key, item]) => [key, clean(item)]),
  )
}

function validate(value: unknown) {
  if (!value || typeof value !== "object" || !("role" in value)) return modelMessageSchema.safeParse(value)
  if (value.role === "system") return systemModelMessageSchema.safeParse(value)
  if (value.role === "user") return userModelMessageSchema.safeParse(value)
  if (value.role === "assistant") return assistantModelMessageSchema.safeParse(value)
  if (value.role === "tool") return toolModelMessageSchema.safeParse(value)
  return modelMessageSchema.safeParse(value)
}

function path(index: number, error: ReturnType<typeof validate>) {
  if (error.success) return `messages[${index}]`
  const visit = (issues: readonly unknown[], prefix: PropertyKey[] = []): PropertyKey[] =>
    issues.reduce<PropertyKey[]>((best, issue) => {
      if (!issue || typeof issue !== "object") return best
      const row = issue
      const own = [...prefix, ...("path" in row && Array.isArray(row.path) ? row.path : [])]
      const nested = ("errors" in row && Array.isArray(row.errors) ? row.errors : [])
        .filter(Array.isArray)
        .map((group) => visit(group, own))
        .reduce<PropertyKey[]>((left, right) => (right.length > left.length ? right : left), [])
      return own.length >= best.length && own.length >= nested.length
        ? own
        : nested.length >= best.length
          ? nested
          : best
    }, [])
  const parts = visit(error.error.issues)
  const safe = parts.flatMap((part, offset) => {
    if (parts.slice(0, offset).includes("providerOptions")) return []
    if (part === "providerOptions") return [".providerOptions", ".*"]
    return [typeof part === "number" ? `[${part}]` : `.${String(part)}`]
  })
  return [`messages[${index}]`, ...safe].join("")
}

export namespace KiloModelHistory {
  export function repair(input: readonly unknown[]) {
    const messages: ModelMessage[] = []
    const repairs: Repair[] = []
    for (const [index, message] of input.entries()) {
      const parsed = validate(message)
      if (parsed.success) {
        messages.push(parsed.data)
        continue
      }
      const cleaned = validate(clean(message))
      if (cleaned.success) {
        messages.push(cleaned.data)
        repairs.push({ path: path(index, parsed), role: cleaned.data.role, action: "metadata-stripped" })
        continue
      }
      const role =
        message && typeof message === "object" && "role" in message && typeof message.role === "string"
          ? message.role
          : "unknown"
      repairs.push({ path: path(index, parsed), role, action: "message-dropped" })
    }
    return { messages, repairs }
  }
}
