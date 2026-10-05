import { z } from "zod"

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const model = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine((value) => !value.includes("://") && !value.split("/").some((part) => !part || part === ".."))
const selection = z.object({ providerID: identifier, modelID: model }).strict()
const picks = z.array(selection).max(1000)
const variants = z
  .array(selection.extend({ variant: identifier }))
  .max(128)
  .superRefine((value, ctx) => {
    const keys = value.map((item) => `${item.providerID}/${item.modelID}`)
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Duplicate model variant preference" })
  })
const state = z
  .object({
    models: z.array(selection.extend({ agent: identifier })).max(1000),
    recent: picks,
    favorite: picks,
    variants: variants.optional(),
  })
  .strict()

/** Inactive review evidence only. This schema cannot authorize execution or reconnect a provider. */
export const preferences = z
  .object({
    format: z.literal("raya.profile-preferences"),
    version: z.literal(1),
    reviewOnly: z.literal(true),
    activation: z.literal("held"),
    config: z
      .object({ model: selection.optional(), smallModel: selection.optional(), defaultAgent: identifier.optional() })
      .strict(),
    modelState: state,
    extensionState: z
      .object({
        recentModels: picks,
        favoriteModels: picks,
        variants: variants.optional(),
        expanded: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const agents = value.modelState.models.map((item) => item.agent)
    if (new Set(agents).size !== agents.length) ctx.addIssue({ code: "custom", message: "Duplicate agent preference" })
  })

function record(value: unknown) {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Expected preference data object")
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new Error("Expected plain preference data")
  return value
}

function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) throw new Error("Preference accessors are not data")
  return descriptor.value
}

function pick(value: unknown) {
  const data = record(value)
  return selection.parse({ providerID: field(data, "providerID"), modelID: field(data, "modelID") })
}

function list(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid model preference list")
  return Array.from({ length: value.length }, (_, index) => pick(field(value, String(index))))
}

function configured(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("Expected configured model identifier")
  const index = value.indexOf("/")
  if (index < 1) throw new Error("Configured model requires provider/model identifiers")
  return selection.parse({ providerID: value.slice(0, index), modelID: value.slice(index + 1) })
}

/** Only canonical provider/model keys name variant intent; other storage fields remain outside this projection. */
function choices(value: unknown) {
  if (value === undefined) return undefined
  const data = record(value)
  const keys = Object.getOwnPropertyNames(data)
  if (keys.length > 1000) throw new Error("Too many model variant preferences")
  return variants.parse(
    keys.sort().flatMap((key) => {
      const index = key.indexOf("/")
      if (index < 1) return []
      const parsed = selection.safeParse({ providerID: key.slice(0, index), modelID: key.slice(index + 1) })
      if (!parsed.success) throw new Error("Invalid model variant preference key")
      const selected = field(data, key)
      return selected === undefined ? [] : [{ ...parsed.data, variant: identifier.parse(selected) }]
    }),
  )
}

/** Inputs must already be selected under the caller's capture authority; this function performs no I/O. */
export function sanitize(config: unknown, client: unknown) {
  const cfg = record(config)
  const data = record(client)
  const local = record(field(data, "modelState"))
  const vscode = record(field(data, "extensionState"))
  const models = record(field(local, "model"))
  const keys = Object.getOwnPropertyNames(models)
  if (keys.length > 1000) throw new Error("Too many agent model preferences")
  const agent = field(cfg, "default_agent")
  return preferences.parse({
    format: "raya.profile-preferences",
    version: 1,
    reviewOnly: true,
    activation: "held",
    config: {
      model: configured(field(cfg, "model")),
      smallModel: configured(field(cfg, "small_model")),
      defaultAgent: agent === null ? undefined : agent,
    },
    modelState: {
      models: keys.sort().flatMap((key) => {
        const value = field(models, key)
        return value === undefined ? [] : [{ agent: identifier.parse(key), ...pick(value) }]
      }),
      recent: list(field(local, "recent")),
      favorite: list(field(local, "favorite")),
      ...(field(local, "variant") === undefined ? {} : { variants: choices(field(local, "variant")) }),
    },
    extensionState: {
      recentModels: list(field(vscode, "recentModels")),
      favoriteModels: list(field(vscode, "favoriteModels")),
      ...(field(vscode, "variantSelections") === undefined
        ? {}
        : { variants: choices(field(vscode, "variantSelections")) }),
      ...(field(vscode, "modelSelectorExpanded") === undefined
        ? {}
        : { expanded: z.boolean().parse(field(vscode, "modelSelectorExpanded")) }),
    },
  })
}
