import { digest } from "./evidence-digest"

/** Complete resolved publication for one original input, independent of draft presentation. */
export namespace InputReceipt {
  export type Part = {
    id: string
    sessionID: string
    messageID: string
    type: string
    metadata?: Record<string, unknown>
  }
  export type Row = { info: { id: string; sessionID: string; role: string }; parts: Part[] }
  const key = "raya.input.complete"
  export function clean<T extends Part>(part: T): T {
    if (part.type !== "text" || !part.metadata) return part
    const metadata = { ...part.metadata }
    delete metadata[key]
    return { ...part, metadata: Object.keys(metadata).length ? metadata : undefined }
  }
  export const hash = (part: Part) => digest({ tool: "raya-input-part", state: clean(part) })
  export function seal<T extends Part>(info: Row["info"], parts: T[], anchor?: string): T | undefined {
    const part = anchor
      ? parts.find((item) => item.id === anchor && item.type === "text")
      : parts.findLast((item) => item.type === "text")
    if (!part || info.role !== "user" || new Set(parts.map((item) => item.id)).size !== parts.length) return undefined
    if (parts.some((item) => item.sessionID !== info.sessionID || item.messageID !== info.id)) return undefined
    return {
      ...part,
      metadata: {
        ...part.metadata,
        [key]: {
          version: 1,
          sessionID: info.sessionID,
          messageID: info.id,
          parts: parts.map((item) => ({ id: item.id, sha: hash(item) })),
        },
      },
    }
  }
  export function complete(row: Row | undefined, sessionID: string, messageID: string): boolean {
    if (!row || row.info.role !== "user" || row.info.id !== messageID || row.info.sessionID !== sessionID) return false
    if (!row.parts.length || new Set(row.parts.map((part) => part.id)).size !== row.parts.length) return false
    if (row.parts.some((part) => part.sessionID !== sessionID || part.messageID !== messageID)) return false
    const markers = row.parts.filter((part) => part.type === "text" && part.metadata && key in part.metadata)
    if (markers.length !== 1) return false
    const proof = markers[0].metadata?.[key]
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false
    if (!("version" in proof) || proof.version !== 1 || !("sessionID" in proof) || proof.sessionID !== sessionID)
      return false
    if (!("messageID" in proof) || proof.messageID !== messageID || !("parts" in proof) || !Array.isArray(proof.parts))
      return false
    if (Object.keys(proof).length !== 4 || proof.parts.length !== row.parts.length) return false
    const ids = new Set<string>()
    for (const item of proof.parts) {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 2) return false
      if (!("id" in item) || typeof item.id !== "string" || ids.has(item.id)) return false
      if (!("sha" in item) || typeof item.sha !== "string" || !/^[a-f0-9]{64}$/.test(item.sha)) return false
      const part = row.parts.find((part) => part.id === item.id)
      if (!part || hash(part) !== item.sha) return false
      ids.add(item.id)
    }
    return true
  }
}
