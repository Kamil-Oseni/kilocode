import { z } from "zod"
import { CUSTOM_PROVIDER_PACKAGE, CUSTOM_PROVIDER_PACKAGES, PROVIDER_ID_PATTERN } from "./provider-model"
import type { CustomProviderPackage } from "./provider-model"

const INVALID_PROVIDER_ID = "Invalid provider ID"
const INVALID_ENV = "Invalid environment variable name"
const INVALID_BASE_URL = "Base URL must start with http:// or https://"

export const ProviderIDSchema = z.string().trim().regex(PROVIDER_ID_PATTERN, INVALID_PROVIDER_ID)
export const EnvSchema = z
  .string()
  .trim()
  .regex(/^[A-Z_][A-Z0-9_]*$/, INVALID_ENV)

const VariantConfigSchema = z.record(z.string(), z.unknown())

export type VariantConfig = z.infer<typeof VariantConfigSchema>

// Mirror the CLI provider schema so the UI preserves hand-written configs.
const ModalitySchema = z.enum(["text", "audio", "image", "video", "pdf"])

const ModelModalitiesSchema = z.object({
  input: z.array(ModalitySchema).optional(),
  output: z.array(ModalitySchema).optional(),
})

export type ModelModalities = z.infer<typeof ModelModalitiesSchema>

const Tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const LimitsSchema = z
  .object({ context: Tokens, input: Tokens.optional(), output: Tokens })
  .strict()
  .superRefine((limit, ctx) => {
    for (const field of ["input", "output"] as const) {
      if (limit.context > 0 && (limit[field] ?? 0) > limit.context)
        ctx.addIssue({ code: "custom", path: [field], message: "Must fit within the context window" })
    }
  })

type Limits = z.infer<typeof LimitsSchema>

export function customProviderModelSettings(value: unknown) {
  const model = isRecord(value) ? value : {}
  const limit = isRecord(model.limit) ? model.limit : undefined
  const text = (field: string) => (typeof limit?.[field] === "number" && limit[field] !== 0 ? String(limit[field]) : "")
  return {
    limits: limit !== undefined,
    inputSet: !!limit && Object.hasOwn(limit, "input"),
    context: text("context"),
    input: text("input"),
    output: text("output"),
    tools: typeof model.tool_call === "boolean" ? model.tool_call : undefined,
  }
}

export function parseCustomProviderLimits(model: {
  context?: string
  input?: string
  output?: string
  limits?: boolean
  inputSet?: boolean
}) {
  const errors: { context?: string; input?: string; output?: string } = {}
  const fields = ["context", "input", "output"] as const
  const active = model.limits || fields.some((field) => model[field]?.trim())
  if (!active) return { errors, value: undefined }
  const values: Limits = { context: 0, output: 0, ...(model.inputSet ? { input: 0 } : {}) }
  for (const field of fields) {
    const raw = model[field]?.trim() ?? ""
    if (!raw) continue
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      errors[field] = "Enter a whole number of tokens, or leave blank if unknown"
      continue
    }
    values[field] = value
  }
  const result = LimitsSchema.safeParse(values)
  if (!result.success)
    for (const issue of result.error.issues) {
      const field = issue.path[0]
      if (field === "context" || field === "input" || field === "output") errors[field] ??= issue.message
    }
  return { errors, value: Object.values(errors).some(Boolean) ? undefined : values }
}

export const CustomProviderConfigSchema = z
  .object({
    npm: z.enum(CUSTOM_PROVIDER_PACKAGES).default(CUSTOM_PROVIDER_PACKAGE),
    name: z.string().trim().min(1).max(200),
    env: z.array(EnvSchema).max(1).optional(),
    options: z
      .object({
        localInference: z.boolean().optional(),
        baseURL: z
          .string()
          .trim()
          .url()
          .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
            message: INVALID_BASE_URL,
          }),
        headers: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
      })
      .strict(),
    models: z
      .record(
        z.string().trim().min(1),
        z
          .object({
            name: z.string().trim().min(1).max(200),
            reasoning: z.boolean().optional(),
            tool_call: z.boolean().optional(),
            limit: LimitsSchema.optional(),
            modalities: ModelModalitiesSchema.optional(),
            variants: z.record(z.string().trim().min(1), VariantConfigSchema).optional(),
          })
          .strict(),
      )
      .refine((value) => Object.keys(value).length > 0, "At least one model is required"),
  })
  .strict()

export type SanitizedProviderConfig = {
  npm: CustomProviderPackage
  name: string
  env?: string[]
  options: {
    baseURL: string
    localInference?: boolean
    headers?: Record<string, string>
  }
  models: Record<
    string,
    {
      name: string
      reasoning?: true
      tool_call?: boolean
      limit?: Limits
      modalities?: ModelModalities
      variants?: Record<string, VariantConfig>
    }
  >
}

export type CustomProviderAuthChange = { mode: "preserve" } | { mode: "clear" } | { mode: "set"; key: string }

export const MASKED_CUSTOM_PROVIDER_KEY = "********"

type Issue = { error: string; issue?: z.ZodIssue }

function fail(error: string, issue?: z.ZodIssue): Issue {
  return issue ? { error, issue } : { error }
}

export function validateProviderID(providerID: string): { value: string } | Issue {
  const result = ProviderIDSchema.safeParse(providerID)
  if (result.success) return { value: result.data }
  const issue = result.error.issues[0]
  return fail(issue?.message ?? INVALID_PROVIDER_ID, issue)
}

export function parseCustomProviderSecret(raw: string): { value: { apiKey?: string; env?: string } } | Issue {
  const value = raw.trim()
  if (!value) return { value: {} }

  const match = value.match(/^\{env:([^}]+)\}$/)
  if (!match) return { value: { apiKey: value } }

  const env = match[1]?.trim() ?? ""
  const result = EnvSchema.safeParse(env)
  if (result.success) return { value: { env: result.data } }
  const issue = result.error.issues[0]
  return fail(issue?.message ?? INVALID_ENV, issue)
}

export function resolveCustomProviderAuth(apiKey: string | undefined, changed: boolean): CustomProviderAuthChange {
  const key = apiKey?.trim()
  if (!changed) return { mode: "preserve" }
  if (key) return { mode: "set", key }
  return { mode: "clear" }
}

export function resolveCustomProviderKey(auth: "api" | "oauth" | "wellknown" | undefined) {
  if (auth !== "api") return ""
  return MASKED_CUSTOM_PROVIDER_KEY
}

export function normalizeCustomProviderConfig(
  config: z.output<typeof CustomProviderConfigSchema>,
): SanitizedProviderConfig {
  const headers = config.options.headers
    ? Object.fromEntries(
        Object.entries(config.options.headers)
          .map(([key, value]) => [key.trim(), value.trim()] as const)
          .filter(([key, value]) => key.length > 0 && value.length > 0),
      )
    : undefined

  return {
    npm: config.npm,
    name: config.name.trim(),
    ...(config.env ? { env: config.env.map((item) => item.trim()) } : {}),
    options: {
      baseURL: config.options.baseURL.trim(),
      ...(config.options.localInference !== undefined ? { localInference: config.options.localInference } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    },
    models: Object.fromEntries(
      Object.entries(config.models).map(([id, model]) => [
        id.trim(),
        {
          name: model.name.trim(),
          ...(model.reasoning ? { reasoning: true as const } : {}),
          ...(model.tool_call !== undefined ? { tool_call: model.tool_call } : {}),
          ...(model.limit ? { limit: model.limit } : {}),
          ...(model.modalities ? { modalities: model.modalities } : {}),
          ...(model.variants && Object.keys(model.variants).length > 0 ? { variants: model.variants } : {}),
        },
      ]),
    ),
  }
}

export function customProviderLocalInference(provider: unknown): boolean | undefined {
  const options = isRecord(provider) && isRecord(provider.options) ? provider.options : undefined
  return typeof options?.localInference === "boolean" ? options.localInference : undefined
}

export function sanitizeCustomProviderConfig(provider: unknown): { value: SanitizedProviderConfig } | Issue {
  const result = CustomProviderConfigSchema.safeParse(provider)
  if (!result.success) {
    const issue = result.error.issues[0]
    return fail(issue?.message ?? "Invalid custom provider config", issue)
  }

  return { value: normalizeCustomProviderConfig(result.data) }
}

type AnyRecord = Record<string, unknown>
type VariantPatch = Partial<{ [Key in keyof VariantConfig]: VariantConfig[Key] | null }>
type ProviderPatch = Omit<SanitizedProviderConfig, "models"> & {
  models: Record<
    string,
    null | {
      name: string
      reasoning?: true | null
      tool_call?: boolean
      limit?: Limits
      modalities?: ModelModalities | null
      variants?: Record<string, VariantConfig | VariantPatch | null>
    }
  >
}

function isRecord(v: unknown): v is AnyRecord {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/**
 * Build a provider patch that includes null sentinels for model properties,
 * variants, and variant options that existed in the previous config but are
 * absent from the new one. The CLI `config.update` endpoint deep-merges the
 * payload with the existing config; without explicit nulls, removed entries
 * would persist on disk.
 */
export function withCustomProviderDeletions(existing: unknown, next: SanitizedProviderConfig): SanitizedProviderConfig {
  if (!isRecord(existing)) return next
  const oldModels = isRecord(existing.models) ? existing.models : {}
  const patched: ProviderPatch["models"] = { ...next.models }

  for (const id of Object.keys(oldModels)) {
    if (!(id in patched)) {
      patched[id] = null
      continue
    }
    const oldModel = oldModels[id]
    const newModel = patched[id]
    if (!isRecord(oldModel) || !isRecord(newModel)) continue
    const oldVariants = isRecord(oldModel.variants) ? oldModel.variants : {}
    const newVariants = isRecord(newModel.variants) ? newModel.variants : {}
    const changes: Record<string, VariantPatch | null> = {}
    for (const [name, oldVariant] of Object.entries(oldVariants)) {
      if (!(name in newVariants)) {
        changes[name] = null
        continue
      }
      const newVariant = newVariants[name]
      if (!isRecord(oldVariant) || !isRecord(newVariant)) continue
      const removed = Object.keys(oldVariant).filter((key) => !(key in newVariant))
      if (removed.length === 0) continue
      const nulls = Object.fromEntries(removed.map((key) => [key, null]))
      changes[name] = { ...newVariant, ...nulls } as VariantPatch
    }
    const variants = Object.keys(changes).length > 0 ? { ...newVariants, ...changes } : newModel.variants
    patched[id] = {
      ...newModel,
      ...(variants ? { variants } : {}),
      ...(oldModel.reasoning !== undefined && newModel.reasoning === undefined ? { reasoning: null } : {}),
      ...(oldModel.modalities !== undefined && newModel.modalities === undefined ? { modalities: null } : {}),
    }
  }

  return { ...next, models: patched } as SanitizedProviderConfig
}
