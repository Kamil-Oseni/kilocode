import path from "node:path"
import z from "zod"
import { Intent, LineageIntent, MarkdownIntent } from "./config-intent-schema"

const file = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value))
export const GlobalScopes = z
  .object({
    data: file,
    config: file,
    cache: file,
    state: file,
    stateParent: file,
    bin: file,
    log: file,
    repos: file,
    homeKilocode: file,
    homeConfigKilo: file,
  })
  .strict()
export const SourceScopes = z.union([
  z.object({ version: z.literal(1), states: z.array(file).max(128) }).strict(),
  z.object({ version: z.literal(2), states: z.array(file).max(128), globals: z.array(GlobalScopes).max(128) }).strict(),
  z
    .object({
      version: z.literal(3),
      states: z.array(file).max(128),
      globals: z.array(GlobalScopes).max(128),
      configs: z
        .array(Intent)
        .max(128)
        .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024),
      configStatus: z.enum(["complete", "uncertain", "overflow"]),
      configReason: z.enum(["origin-uncertain", "unsupported-fields", "metadata-overflow"]).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(4),
      states: z.array(file).max(128),
      globals: z.array(GlobalScopes).max(128),
      configs: z
        .array(z.union([MarkdownIntent, LineageIntent]))
        .max(128)
        .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024),
      configStatus: z.enum(["complete", "uncertain", "overflow"]),
      configReason: z.enum(["origin-uncertain", "unsupported-fields", "metadata-overflow"]).optional(),
    })
    .strict(),
])

/** Pure metadata validation; callers still require exact acknowledged ownership and physical policy. */
export function scopePaths(input: unknown) {
  const value = SourceScopes.parse(input)
  const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
  const ordered = (names: string[]) => {
    const sorted = [...names].sort()
    if (new Set(names).size !== names.length || names.some((name, index) => name !== sorted[index]))
      throw new Error("Source scopes are not ordered and distinct")
  }
  ordered(value.states.map(key))
  if (value.version === 1) return { value, paths: value.states, origins: [] as string[] }
  ordered(
    value.globals.map((roles) =>
      JSON.stringify(Object.fromEntries(Object.entries(roles).map(([role, file]) => [role, key(file)]))),
    ),
  )
  const states = [...new Set(value.globals.map((roles) => key(roles.state)))].sort()
  if (JSON.stringify(states) !== JSON.stringify(value.states.map(key)))
    throw new Error("Global state roles disagree with the source state inventory")
  if (value.version === 3 || value.version === 4) {
    if (value.configStatus === "complete" && value.configReason !== undefined)
      throw new Error("Complete configuration scope has a refusal reason")
    if (value.configStatus !== "complete" && (value.configs.length !== 0 || !value.configReason))
      throw new Error("Incomplete configuration scope lacks explicit refusal metadata")
    if ((value.configStatus === "overflow") !== (value.configReason === "metadata-overflow"))
      throw new Error("Configuration scope refusal status differs")
    ordered(value.configs.map((graph) => graph.graph))
    for (const graph of value.configs) {
      if (
        !value.globals.some(
          (roles) =>
            key(roles.data) === key(graph.roots.data) &&
            key(roles.config) === key(graph.roots.config) &&
            key(roles.state) === key(graph.roots.state),
        )
      )
        throw new Error("Configuration graph lacks its realized Global tuple")
    }
  }
  return {
    value,
    paths: [...new Set(value.globals.flatMap((roles) => Object.values(roles)))],
    origins:
      value.version === 3 || value.version === 4
        ? [
            ...new Set(
              value.configs.flatMap((graph) =>
                [...graph.documents, ...("markdown" in graph ? graph.markdown : [])].map((document) => document.path),
              ),
            ),
          ]
        : [],
  }
}
