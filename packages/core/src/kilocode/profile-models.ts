import { sanitize } from "./profile-preferences"

/** The single safe CLI-state projection used by loaded host evidence and native file binding. */
export function project(state: ReturnType<typeof sanitize>["modelState"]) {
  return {
    recent: state.recent,
    favorite: state.favorite,
    agents: state.models,
    ...(state.variants === undefined ? {} : { variants: state.variants }),
  }
}

/** Capsule-shaped JSON is not a CLI model store, even when an empty projection would coincide. */
export function read(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CLI model preference record is invalid")
  if (["selected", "agents", "variants", "expanded"].some((key) => Object.hasOwn(raw, key)))
    throw new Error("Projected host choices are not a CLI model preference record")
  return project(sanitize({}, { modelState: raw }).modelState)
}
