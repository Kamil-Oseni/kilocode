import { createHash } from "node:crypto"
import matter from "gray-matter"
import path from "node:path"
import z from "zod"

const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const exclusion = z
  .object({
    field: name,
    reason: z.enum([
      "credential-or-execution",
      "recognized-credential",
      "substitution",
      "unsupported",
      "invalid-safe-field",
    ]),
  })
  .strict()
const fields = z
  .object({
    description: z.string().max(2048).optional(),
    displayName: z.string().max(128).optional(),
    model: name.optional(),
    variant: name.optional(),
    agent: name.optional(),
    mode: z.enum(["primary", "subagent", "all"]).optional(),
    color: z.string().max(64).optional(),
    hidden: z.boolean().optional(),
    disable: z.boolean().optional(),
  })
  .strict()
export const Projection = z
  .object({ safe: fields, body: z.string().max(1048576), excluded: z.array(exclusion).max(256) })
  .strict()
export const MarkdownOrigin = z
  .object({
    path: absolute,
    digest: hash,
    bytes: z.number().int().nonnegative().max(1048576),
    identity: z.object({ dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/) }).strict(),
    kind: z.enum(["agent", "command", "mode"]),
    name,
    trusted: z.boolean(),
    order: z.number().int().nonnegative().max(4096),
    projection: hash,
  })
  .strict()
/** Prior accepted descriptors remain inert; only the current origin binds a physical file. */
export const MarkdownLineageOrigin = MarkdownOrigin.extend({
  history: z.array(MarkdownOrigin).max(64).optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    for (const entry of value.history ?? [])
      if (
        entry.path !== value.path ||
        entry.kind !== value.kind ||
        entry.name !== value.name ||
        entry.trusted !== value.trusted ||
        entry.order !== value.order
      )
        ctx.addIssue({ code: "custom", message: "Markdown history loader binding differs" })
  })
const unsafe = new Set([
  "permission",
  "permissions",
  "permissionMode",
  "tools",
  "disallowedTools",
  "options",
  "provider",
  "mcp",
  "headers",
  "apiKey",
  "token",
  "secret",
  "hooks",
  "command",
  "commands",
  "subtask",
  "background",
  "isolation",
  "memory",
  "temperature",
  "top_p",
  "steps",
  "maxSteps",
  "source",
])
// A fixed recognized-format guard, not a claim to detect arbitrary secrets in prose.
const credentials = (text: string) =>
  /(?:\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9_]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passphrase|api[_ -]?key|secret|token|credential|private[_ -]?key|access[_ -]?key)\s*[:=]\s*\S+)/i.test(
    text,
  )

function frontmatter(text: string) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!block) return text
  const content = block[1]
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s/.test(line) || !line.trim() || line.trim().startsWith("#")) return line
      const field = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
      if (!field) return line
      const value = field[2].trim()
      if (!value || /^[>|"']/.test(value) || !value.includes(":")) return line
      return `${field[1]}: ${JSON.stringify(value)}`
    })
    .join("\n")
  return text.replace(block[1], () => content)
}

/** Project original accepted Markdown, never the loader's substituted content. This is inert review evidence. */
export function projectMarkdown(text: string) {
  if (Buffer.byteLength(text) > 1048576) throw new Error("Markdown intent document exceeds bounds")
  // The active loader mutates gray-matter's cached content after substitution.
  // Explicit options force a fresh raw parse instead of reusing that resolved object.
  const value = (() => {
    try {
      return matter(text, {})
    } catch {
      return matter(frontmatter(text), {})
    }
  })()
  const safe: Record<string, unknown> = {}
  const excluded: z.output<typeof exclusion>[] = []
  for (const [field, item] of Object.entries(value.data)) {
    name.parse(field)
    if (credentials(JSON.stringify(item))) {
      excluded.push({ field, reason: "recognized-credential" })
      continue
    }
    if (/\{(?:env|file):/i.test(JSON.stringify(item))) {
      excluded.push({ field, reason: "substitution" })
      continue
    }
    const schema = Object.entries(fields.shape).find(([key]) => key === field)?.[1]
    if (!schema) {
      excluded.push({ field, reason: unsafe.has(field) ? "credential-or-execution" : "unsupported" })
      continue
    }
    const result = schema.safeParse(item)
    if (!result.success || (typeof item === "string" && /(?:https?:\/\/|\.\.)/.test(item))) {
      excluded.push({ field, reason: "invalid-safe-field" })
      continue
    }
    safe[field] = result.data
  }
  const substituted = /\{(?:env|file):/i.test(value.content)
  const executable = /!`[^`]*`/.test(value.content)
  const credential = credentials(value.content)
  if (credential) excluded.push({ field: "body", reason: "recognized-credential" })
  if (substituted || executable)
    excluded.push({ field: "body", reason: substituted ? "substitution" : "credential-or-execution" })
  return Projection.parse({ safe, body: substituted || executable || credential ? "" : value.content.trim(), excluded })
}
export function markdownDigest(value: z.output<typeof Projection>) {
  return createHash("sha256")
    .update(JSON.stringify(Projection.parse(value)))
    .digest("hex")
}
