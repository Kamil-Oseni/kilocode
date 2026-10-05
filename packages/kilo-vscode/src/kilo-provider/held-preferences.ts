import { sanitize } from "@opencode-ai/core/kilocode/profile-preferences"

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Reuses the migration codec; unrelated credentials and execution settings are omitted. */
export function held(client: unknown) {
  return freeze(sanitize({}, client))
}
