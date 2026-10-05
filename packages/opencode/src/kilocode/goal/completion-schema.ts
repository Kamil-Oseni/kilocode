import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect } from "effect"
import type { SessionID } from "@/session/schema"

type Saved = { criteria?: readonly { id: string; description: string }[] } | undefined
const owners = new WeakMap<JSONSchema7, { base: JSONSchema7; read: (id: SessionID) => Effect.Effect<Saved> }>()

export function owned(base: JSONSchema7, read: (id: SessionID) => Effect.Effect<Saved>) {
  const schema = completion(base)
  owners.set(schema, { base, read })
  return schema
}

export const prepare = Effect.fn("GoalSchema.prepare")(function* (id: string, base: JSONSchema7, session: SessionID) {
  const owner = id === "update_goal" ? owners.get(base) : undefined
  if (!owner) return base
  const saved = yield* owner.read(session)
  return saved?.criteria?.length ? completion(owner.base, saved.criteria) : base
})

/** Match the completion audit requirement while retaining the compatible control decoder. */
export function completion(base: JSONSchema7, criteria?: readonly { id: string; description: string }[]): JSONSchema7 {
  const source = base.properties?.requirements
  const audit = base.properties?.audit
  if (!source || typeof source !== "object" || source.type !== "array" || !audit || typeof audit !== "object")
    throw new Error("Goal completion schema requires the actual audit definitions")
  const nested = audit.properties?.requirements
  if (!nested || typeof nested !== "object" || nested.type !== "array")
    throw new Error("Goal completion schema requires native audit requirements")
  const require = (array: JSONSchema7): JSONSchema7 => {
    if (!criteria?.length) return array
    const item = array.items
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "object")
      throw new Error("Goal criterion schema requires the actual requirement definition")
    const criterion = item.properties?.criterionID
    if (!criterion || typeof criterion !== "object")
      throw new Error("Goal criterion schema requires the actual identifier definition")
    const description = item.properties?.requirement
    if (!description || typeof description !== "object")
      throw new Error("Goal criterion schema requires the actual description definition")
    return {
      ...array,
      description: `Include exactly ${criteria.length} requirements, one for each saved criterion ID, with no duplicates.`,
      minItems: criteria.length,
      maxItems: criteria.length,
      uniqueItems: true,
      items: {
        ...item,
        properties: { ...item.properties, criterionID: { ...criterion, enum: criteria.map((item) => item.id) } },
        required: [...new Set([...(item.required ?? []), "criterionID"])],
        oneOf: criteria.map((row) => ({
          ...item,
          properties: {
            ...item.properties,
            criterionID: { ...criterion, const: row.id },
            requirement: { ...description, const: row.description },
          },
          required: [...new Set([...(item.required ?? []), "criterionID", "requirement"])],
        })),
      },
    }
  }
  const flat = require(source)
  const native = { ...audit, properties: { ...audit.properties, requirements: require(nested) } }
  const properties = { ...base.properties, requirements: flat, audit: native }
  return {
    ...base,
    anyOf: [
      {
        ...base,
        properties: { ...base.properties, status: { enum: ["active", "blocked", "paused"] } },
      },
      {
        ...base,
        properties: {
          ...properties,
          status: { const: "complete" },
          requirements: { ...flat, minItems: flat.minItems ?? 1 },
        },
        required: [...new Set([...(base.required ?? []), "requirements"])],
      },
      {
        ...base,
        properties: {
          ...properties,
          status: { const: "complete" },
          audit: {
            ...native,
            properties: { ...native.properties, requirements: { ...require(nested), minItems: flat.minItems ?? 1 } },
          },
        },
        required: [...new Set([...(base.required ?? []), "audit"])],
      },
    ],
  }
}
