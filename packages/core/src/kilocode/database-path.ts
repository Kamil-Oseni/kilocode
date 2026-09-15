import { existsSync } from "node:fs"
import path from "node:path"

type Exists = (file: string) => boolean

export type Channel = {
  data: string
  channel: string
  disabled: boolean
  exists?: Exists
}

export type Input = Channel & {
  override?: string
}

export function channel(input: Channel) {
  if (["latest", "beta", "prod"].includes(input.channel) || input.disabled) return path.join(input.data, "kilo.db")
  const safe = input.channel.replace(/[^a-zA-Z0-9._-]/g, "-")
  const next = path.join(input.data, `kilo-${safe}.db`)
  const prev = path.join(input.data, `opencode-${safe}.db`)
  const exists = input.exists ?? existsSync
  if (!exists(next) && exists(prev)) return prev
  return next
}

export function resolve(input: Input) {
  if (!input.override) return channel(input)
  if (input.override === ":memory:" || path.isAbsolute(input.override)) return input.override
  return path.join(input.data, input.override)
}
