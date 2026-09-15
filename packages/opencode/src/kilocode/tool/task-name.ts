import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import type { SessionID } from "@/session/schema"

export namespace TaskName {
  export const key = "raya.task.identity"
  export const gate = KeyedMutex.makeUnsafe<SessionID>()

  export type Source = "description" | "objective" | "prompt" | "fallback"

  export type Identity = {
    version: 1
    displayName: string
    baseName: string
    ordinal: number
    specialist: string
    selection: "auto" | "explicit"
    provenance: {
      source: Source
      parentSessionID: SessionID
      parentMessageID: string
      callID?: string
    }
  }

  function clean(value: string) {
    return Array.from(value, (char) => {
      const code = char.charCodeAt(0)
      return code < 32 || code === 127 ? " " : char
    })
      .join("")
      .replace(/<[^>]*>/g, " ")
      .replace(/[`*_#>[\]{}]/g, " ")
      .replace(/^\s*(?:please\s+)?(?:can|could|would)\s+you\s+/i, "")
      .replace(/^\s*(?:please\s+)?(?:i\s+(?:want|need)\s+you\s+to|your\s+task\s+is\s+to)\s+/i, "")
      .split(/[\r\n.!?;]+/, 1)[0]!
      .replace(/\s+/g, " ")
      .trim()
  }

  function shorten(value: string) {
    const words = value.split(" ").filter(Boolean).slice(0, 7)
    const text = words.join(" ").slice(0, 64).trim()
    return text.replace(/[,.:;-]+$/, "").trim()
  }

  function title(value: string) {
    if (!value) return value
    return value[0]!.toLocaleUpperCase() + value.slice(1)
  }

  export function base(input: { description: string; objective?: string; prompt?: string }) {
    const description = shorten(clean(input.description))
    const generic = /^(?:task|work|help|research|investigate|review|analyze|analyse)$/i.test(description)
    const fields: readonly [Source, string | undefined][] = [
      ["description", generic ? undefined : description],
      ["objective", input.objective],
      ["prompt", input.prompt],
    ]
    const found = fields.map(([source, value]) => ({ source, value: shorten(clean(value ?? "")) })).find((x) => x.value)
    return found ?? { source: "fallback" as const, value: "Delegated task" }
  }

  export function read(value: unknown): Identity | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    if (item.version !== 1) return
    if (typeof item.displayName !== "string" || typeof item.baseName !== "string") return
    if (typeof item.ordinal !== "number" || !Number.isInteger(item.ordinal) || item.ordinal < 1) return
    if (typeof item.specialist !== "string") return
    if (item.selection !== "auto" && item.selection !== "explicit") return
    if (!item.provenance || typeof item.provenance !== "object" || Array.isArray(item.provenance)) return
    const provenance = item.provenance as Record<string, unknown>
    if (!["description", "objective", "prompt", "fallback"].includes(String(provenance.source))) return
    if (typeof provenance.parentSessionID !== "string" || typeof provenance.parentMessageID !== "string") return
    if (provenance.callID !== undefined && typeof provenance.callID !== "string") return
    return value as Identity
  }

  export function allocate(input: {
    description: string
    objective?: string
    prompt?: string
    specialist: string
    selection: "auto" | "explicit"
    parentSessionID: SessionID
    parentMessageID: string
    callID?: string
    siblings: readonly { title: string; metadata?: Record<string, unknown> }[]
  }): Identity {
    const found = base(input)
    const baseName = `${title(found.value)} · ${title(input.specialist)}`
    const ordinals = input.siblings.flatMap((session) => {
      const identity = read(session.metadata?.[key])
      if (identity?.baseName === baseName) return [identity.ordinal]
      if (session.title === baseName) return [1]
      const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const match = session.title.match(new RegExp(`^${escaped} \\((\\d+)\\)$`))
      return match ? [Number(match[1])] : []
    })
    const ordinal = Math.max(0, ...ordinals) + 1
    const displayName = ordinal === 1 ? baseName : `${baseName} (${ordinal})`
    return {
      version: 1,
      displayName,
      baseName,
      ordinal,
      specialist: input.specialist,
      selection: input.selection,
      provenance: {
        source: found.source,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
        ...(input.callID ? { callID: input.callID } : {}),
      },
    }
  }
}
