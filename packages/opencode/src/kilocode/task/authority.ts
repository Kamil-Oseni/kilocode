import { Schema } from "effect"

const MAX_SERVICES = 64
const MAX_TOOLS = 512
const Name = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(128))
const Tool = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(256))

export const Service = Schema.Struct({
  name: Name,
  tools: Schema.Array(Tool).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TOOLS)),
})

export const Catalog = Schema.Struct({
  services: Schema.Array(Service).check(Schema.isMaxLength(MAX_SERVICES)),
  truncated: Schema.Boolean,
})

export type Catalog = typeof Catalog.Type

export function catalog(entries: Record<string, { clientName: string }>): Catalog {
  const groups = new Map<string, string[]>()
  const rows = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))
  let count = 0
  let truncated = false

  for (const [tool, entry] of rows) {
    if (count >= MAX_TOOLS) {
      truncated = true
      break
    }
    const name = entry.clientName.trim()
    if (!name || name.length > 128 || !tool.trim() || tool.length > 256) {
      truncated = true
      continue
    }
    const prior = groups.get(name)
    if (!prior && groups.size >= MAX_SERVICES) {
      truncated = true
      continue
    }
    groups.set(name, [...(prior ?? []), tool])
    count++
  }

  return {
    services: [...groups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, tools]) => ({ name, tools })),
    truncated,
  }
}

export * as RayaTaskAuthority from "./authority"
