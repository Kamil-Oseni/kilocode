// kilocode_change - new file
import { createHash } from "node:crypto"

export const SHADOW_LIMIT = 16

export type Kind = "builtin" | "global" | "project" | "config" | "path" | "url"

export type Source = {
  kind: Kind
  locator: string
  trusted: boolean
}

export type Shadow = Source & {
  version?: string
  sha256: string
  order: number
}

export type Receipt = {
  version: 1
  source: Source
  skillVersion?: string
  sha256: string
  resolution: {
    result: "selected"
    order: number
    shadowed: Shadow[]
    truncated: boolean
  }
}

export function digest(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function skillVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const version = value.trim()
  if (!version || version.length > 64) return undefined
  return version
}

function selected(receipt: Receipt): Shadow {
  return {
    ...receipt.source,
    version: receipt.skillVersion,
    sha256: receipt.sha256,
    order: receipt.resolution.order,
  }
}

export function resolve(input: {
  source: Source
  content: string
  order: number
  version?: unknown
  previous?: Receipt
}): Receipt {
  const shadowed = input.previous ? [selected(input.previous), ...input.previous.resolution.shadowed] : []
  return {
    version: 1,
    source: input.source,
    skillVersion: skillVersion(input.version),
    sha256: digest(input.content),
    resolution: {
      result: "selected",
      order: input.order,
      shadowed: shadowed.slice(0, SHADOW_LIMIT),
      truncated: (input.previous?.resolution.truncated ?? false) || shadowed.length > SHADOW_LIMIT,
    },
  }
}
