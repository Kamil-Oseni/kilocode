import type { GoalState } from "./goal"

export function valid(value: unknown): value is NonNullable<GoalState["criteria"]> {
  if (!Array.isArray(value) || !value.length || value.length > 20) return false
  const ids = new Set<string>()
  return value.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) ||
      ids.has(item.id) ||
      (item.required !== undefined && typeof item.required !== "boolean") ||
      (item.review !== undefined && typeof item.review !== "boolean")
    )
      return false
    ids.add(item.id)
    return [item.description, item.verification].every(
      (text) => typeof text === "string" && /\S/.test(text) && text.length <= 4000,
    )
  })
}

export function equal(a: GoalState["criteria"], b: GoalState["criteria"]) {
  if (a === undefined || b === undefined) return a === b
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.id === b[index].id &&
        (item.required !== false) === (b[index].required !== false) &&
        (item.review === true) === (b[index].review === true) &&
        item.description === b[index].description &&
        item.verification === b[index].verification,
    )
  )
}
