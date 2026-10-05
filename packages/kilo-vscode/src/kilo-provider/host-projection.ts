import z from "zod"
import path from "node:path"
import { PayloadSchema, type Payload } from "@opencode-ai/core/kilocode/source-capsule"
import { preferences } from "@opencode-ai/core/kilocode/profile-preferences"

const root = z.object({ kind: z.literal("json"), path: z.string() }).strict()
const safe = z.unknown().transform((value) => preferences.parse(value))
const owner = z.object({
  generation: z.string(),
  revision: z.number(),
  roots: z.array(root).max(1),
  preferences: safe.optional(),
})
const view = z.object({
  revision: z.number(),
  models: z.array(owner),
  preferences: z.object({ preferences: safe }).optional(),
})
const contexts = z.array(
  z.object({
    id: z.string(),
    root: z.string(),
    generation: z.string(),
    publication: z.object({ roots: z.array(root).max(1) }).optional(),
  }),
)

function models(value?: ReturnType<typeof preferences.parse>): Payload["hosts"][number]["models"] {
  return {
    selected: value?.config.model,
    recent: value?.extensionState.recentModels ?? [],
    favorite: value?.extensionState.favoriteModels ?? [],
    agents: value?.modelState.models ?? [],
    ...(value?.extensionState.variants === undefined ? {} : { variants: value.extensionState.variants }),
    ...(value?.extensionState.expanded === undefined ? {} : { expanded: value.extensionState.expanded }),
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/** Projects only declared inactive evidence; unknown state is never copied into the capsule. */
export function project(rows: readonly { generation: string; role: "view" | "agent-manager"; payload: unknown }[]) {
  const hosts = rows.map((row) => {
    if (row.role === "agent-manager")
      return {
        id: row.generation,
        role: row.role,
        revision: 0,
        models: models(),
        owners: [],
        contexts: contexts.parse(row.payload).map((item) => ({
          id: item.generation,
          project: item.id,
          path: path.normalize(item.root),
          root: item.publication?.roots[0],
        })),
      }
    const value = view.parse(row.payload)
    return {
      id: row.generation,
      role: row.role,
      revision: value.revision,
      models: models(value.preferences?.preferences),
      owners: value.models.map((item) => ({
        id: item.generation,
        revision: item.revision,
        root: item.roots[0],
        models: item.preferences
          ? {
              selected: item.preferences.config.model,
              recent: item.preferences.modelState.recent,
              favorite: item.preferences.modelState.favorite,
              agents: item.preferences.modelState.models,
              ...(item.preferences.modelState.variants === undefined
                ? {}
                : { variants: item.preferences.modelState.variants }),
            }
          : undefined,
      })),
      contexts: [],
    }
  })
  return freeze(PayloadSchema.parse({ format: "raya.host-capsule", version: 1, hosts }))
}
