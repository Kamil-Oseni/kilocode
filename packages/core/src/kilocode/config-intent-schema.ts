import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import z from "zod"
import { MarkdownLineageOrigin, MarkdownOrigin } from "./config-markdown-schema"
const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file) && path.normalize(file) === file)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const selection = z
  .object({
    model: name.optional(),
    small_model: name.optional(),
    default_agent: name.optional(),
    snapshot: z.boolean().optional(),
    snapshots: z.boolean().optional(),
    privacy_mode: z.boolean().optional(),
    auto_collapse_reasoning: z.boolean().optional(),
    tool_output: z
      .object({ max_lines: z.number().int().positive().optional(), max_bytes: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict()
const exclusion = z
  .object({
    field: z.string().min(1).max(128),
    reason: z.enum(["credential-or-execution", "substitution", "unsupported", "invalid-safe-field", "metadata"]),
  })
  .strict()
const origin = z
  .object({
    path: absolute,
    digest,
    bytes: z.number().int().nonnegative().max(1048576),
    identity: z.object({ dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/) }).strict(),
    safe: selection,
    excluded: z.array(exclusion).max(256),
  })
  .strict()
export const Intent = z
  .object({
    format: z.literal("raya.config-intent"),
    version: z.literal(1),
    graph: z.string().uuid(),
    parser: z.enum(["v1", "v2"]),
    roots: z.object({ data: absolute, config: absolute, state: absolute }).strict(),
    directory: absolute.optional(),
    documents: z.array(origin).max(256),
    reviewOnly: z.literal(true),
    activation: z.literal("held"),
    coverage: z.literal("loaded-json-config-only"),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
const markdown = Intent.extend({
  version: z.literal(2),
  markdown: z.array(MarkdownOrigin).max(256),
  coverage: z.literal("loaded-json-and-markdown-config-only"),
}).strict()
export const MarkdownIntent = markdown.superRefine((value, ctx) => {
  if (value.markdown.some((entry, index) => entry.order !== index))
    ctx.addIssue({ code: "custom", message: "Markdown invocation order differs" })
})

/** Original loaded projections remain inert history after an exactly verified own write. */
export const LineageIntent = markdown
  .extend({
    version: z.literal(3),
    documents: z.array(origin.extend({ history: z.array(origin).max(64).optional() }).strict()).max(256),
    markdown: z.array(MarkdownLineageOrigin).max(256),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.markdown.some((entry, index) => entry.order !== index))
      ctx.addIssue({ code: "custom", message: "Markdown invocation order differs" })
    for (const document of value.documents)
      if (document.history?.some((entry) => entry.path !== document.path))
        ctx.addIssue({ code: "custom", message: "Configuration history path differs" })
  })

const excluded = new Set([
  "shell",
  "server",
  "command",
  "commands",
  "skills",
  "references",
  "reference",
  "watcher",
  "plugin",
  "plugins",
  "share",
  "autoshare",
  "autoupdate",
  "disabled_providers",
  "enabled_providers",
  "remote_control",
  "indexing",
  "console",
  "sandbox",
  "raya_routing",
  "subagent_model",
  "subagent_variant",
  "subagent_variant_overrides",
  "subagent_depth",
  "username",
  "mode",
  "agent",
  "agents",
  "provider",
  "providers",
  "mcp",
  "formatter",
  "lsp",
  "instructions",
  "permission",
  "permissions",
  "tools",
  "web_search",
  "attachment",
  "attachments",
  "enterprise",
  "commit_message",
  "compaction",
  "experimental",
  "layout",
  "logLevel",
  "terminal_command_display",
  "code_edit_display",
  "mcp_tool_display",
  "hide_prompt_training_models",
])

/** Raw configuration and expanded values never enter retained evidence. Unknown fields remain an explicit refusal. */
export function project(text: string) {
  if (Buffer.byteLength(text) > 1048576) throw new Error("Configuration intent document exceeds bounds")
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration intent document is invalid")
  const safe: Record<string, unknown> = {}
  const ledger: z.output<typeof exclusion>[] = []
  for (const [field, item] of Object.entries(value)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field) || field.length > 128)
      throw new Error("Configuration intent field name unsupported")
    if (field === "$schema") {
      ledger.push({ field, reason: "metadata" })
      continue
    }
    if (/\{(?:env|file):/i.test(JSON.stringify(item))) {
      ledger.push({ field, reason: "substitution" })
      continue
    }
    const schema = Object.entries(selection.shape).find(([name]) => name === field)?.[1]
    if (!schema) {
      ledger.push({ field, reason: excluded.has(field) ? "credential-or-execution" : "unsupported" })
      continue
    }
    const result = schema.safeParse(item)
    if (
      !result.success ||
      (typeof item === "string" &&
        (item.includes("://") ||
          item.includes("..") ||
          ((field === "model" || field === "small_model") && !item.includes("/"))))
    ) {
      ledger.push({ field, reason: "invalid-safe-field" })
      continue
    }
    safe[field] = result.data
  }
  return { safe: selection.parse(safe), excluded: ledger }
}
