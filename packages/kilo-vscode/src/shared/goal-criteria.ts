import type { GoalState } from "./goal"

function digest(source: { sha256: unknown; bytes: unknown }) {
  return (
    typeof source.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(source.sha256) &&
    typeof source.bytes === "number" &&
    Number.isSafeInteger(source.bytes) &&
    source.bytes >= 0
  )
}

function equality(value: object) {
  if (!("source" in value) || !("target" in value)) return false
  const source = value.source
  const target = value.target
  if (!source || typeof source !== "object" || !target || typeof target !== "object") return false
  if (!("path" in source) || !("canonical" in source) || !("sha256" in source) || !("bytes" in source)) return false
  if (!("path" in target) || !("canonical" in target)) return false
  return (
    Object.keys(value).every((key) => ["kind", "source", "target"].includes(key)) &&
    Object.keys(source).every((key) => ["path", "canonical", "sha256", "bytes"].includes(key)) &&
    Object.keys(target).every((key) => ["path", "canonical"].includes(key)) &&
    [source.path, source.canonical, target.path, target.canonical].every(
      (text) => typeof text === "string" && text.length <= 4000 && /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(text),
    ) &&
    digest(source)
  )
}

function binding(value: unknown) {
  if (!value || typeof value !== "object") return false
  if (!("kind" in value)) return false
  if (value.kind === "byte-equality") return equality(value)
  if (value.kind !== "command" || !("command" in value) || !("directory" in value)) return false
  return (
    [value.command, value.directory].every(
      (text) => typeof text === "string" && /\S/.test(text) && text.length <= 4000,
    ) &&
    typeof value.directory === "string" &&
    /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(value.directory)
  )
}

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
      (item.review !== undefined && typeof item.review !== "boolean") ||
      (item.check !== undefined && !binding(item.check))
    )
      return false
    ids.add(item.id)
    return [item.description, item.verification].every(
      (text) => typeof text === "string" && /\S/.test(text) && text.length <= 4000,
    )
  })
}

function same(
  a: NonNullable<GoalState["criteria"]>[number]["check"],
  b: NonNullable<GoalState["criteria"]>[number]["check"],
) {
  if (!a || !b) return a === b
  if (a.kind === "command" && b.kind === "command") return a.command === b.command && a.directory === b.directory
  if (a.kind !== "byte-equality" || b.kind !== "byte-equality") return false
  return (
    a.source.path === b.source.path &&
    a.source.canonical === b.source.canonical &&
    a.source.sha256 === b.source.sha256 &&
    a.source.bytes === b.source.bytes &&
    a.target.path === b.target.path &&
    a.target.canonical === b.target.canonical
  )
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
        item.verification === b[index].verification &&
        same(item.check, b[index].check),
    )
  )
}
