export type Mode = Readonly<{ name: string; entity: string; stop?: boolean }>
export type Config = Readonly<{ version: 1; origin: string; entities: readonly string[]; modes: readonly Mode[] }>

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function parse(input: unknown): Config {
  if (
    !record(input) ||
    Object.keys(input).sort().join() !== "entities,modes,origin,version" ||
    input.version !== 1 ||
    typeof input.origin !== "string"
  )
    throw new Error("Invalid Home Assistant configuration")
  const address = origin(input.origin)
  if (
    !Array.isArray(input.entities) ||
    !input.entities.length ||
    input.entities.length > 16 ||
    input.entities.some((id) => typeof id !== "string" || !/^light\.[a-z0-9_]{1,80}$/.test(id)) ||
    new Set(input.entities).size !== input.entities.length
  )
    throw new Error("Select 1–16 unique light entities")
  if (!Array.isArray(input.modes) || input.modes.length > 16) throw new Error("Invalid named light modes")
  const entities = Object.freeze([...input.entities] as string[])
  const modes = input.modes.map((value): Mode => {
    if (
      !record(value) ||
      Object.keys(value).some((key) => !["entity", "name", "stop"].includes(key)) ||
      typeof value.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(value.name) ||
      typeof value.entity !== "string" ||
      !/^(scene|script)\.[a-z0-9_]{1,80}$/.test(value.entity) ||
      (value.stop !== undefined && (typeof value.stop !== "boolean" || !value.entity.startsWith("script.")))
    )
      throw new Error("Named modes require an explicit scene/script allowlist")
    return Object.freeze({
      name: value.name,
      entity: value.entity,
      ...(value.stop === undefined ? {} : { stop: value.stop }),
    })
  })
  if (new Set(modes.map((value) => value.name)).size !== modes.length) throw new Error("Duplicate light mode")
  return Object.freeze({ version: 1, origin: address, entities, modes: Object.freeze(modes) })
}

function origin(value: string) {
  const match = /^(https?):\/\/((?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3})(?::([1-9][0-9]{0,4}))?\/?$/.exec(
    value,
  )
  if (!match) throw new Error("Use a canonical private numeric IPv4 origin")
  const parts = match[2].split(".").map(Number)
  if (
    parts.some((part) => part > 255) ||
    (match[3] && Number(match[3]) > 65535) ||
    !(
      parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    )
  )
    throw new Error("Use a private numeric IPv4 origin")
  return new URL(value).origin
}
