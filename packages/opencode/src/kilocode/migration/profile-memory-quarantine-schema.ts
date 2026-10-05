import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"

const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
export const quarantineName = z
  .string()
  .max(31)
  .regex(/^state\.json\.bad-(0|[1-9][0-9]{0,15})$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(15))))
const reference = z
  .object({
    source: absolute,
    workspace: absolute,
    name: quarantineName,
    bytes: z.number().int().safe().nonnegative().max(1048576),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    activation: z.literal("inert"),
  })
  .strict()

function binding(value: z.output<typeof reference>, ctx: z.RefinementCtx) {
  if (
    path.basename(value.source) !== value.name ||
    path.basename(path.dirname(value.source)) !== MemoryPaths.declared(value.workspace).folder
  )
    ctx.addIssue({ code: "custom", message: "Memory quarantine original selector differs" })
}

/** Original evidence metadata never grants current filesystem or review authority. */
export const quarantineReference = reference.superRefine(binding)
export const quarantineEntry = reference.extend({ text: z.string().max(1048576) }).superRefine((value, ctx) => {
  binding(value, ctx)
  const bytes = Buffer.from(value.text, "utf8")
  if (
    bytes.toString("utf8") !== value.text ||
    bytes.length !== value.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== value.digest
  )
    ctx.addIssue({ code: "custom", message: "Memory quarantine original bytes differ" })
  if (MemoryRedact.text(value.text) !== value.text)
    ctx.addIssue({ code: "custom", message: "Memory quarantine contains credential-shaped content" })
})

/** Historical versions may share a basename; exact original source plus digest is their identity. */
export const quarantine = z
  .array(quarantineEntry)
  .max(64)
  .superRefine((values, ctx) => {
    const ids = new Set<string>()
    const paths = new Map<string, string>()
    for (const value of values) {
      const key = path.normalize(value.source).toLowerCase()
      if (paths.has(key) && paths.get(key) !== value.source)
        ctx.addIssue({ code: "custom", message: "Memory quarantine original paths collide by case" })
      paths.set(key, value.source)
      const id = value.source + ":" + value.digest
      if (ids.has(id)) ctx.addIssue({ code: "custom", message: "Duplicate memory quarantine original evidence" })
      ids.add(id)
    }
    if (values.reduce((sum, value) => sum + value.bytes, 0) > 4 * 1048576)
      ctx.addIssue({ code: "custom", message: "Memory quarantine exceeds its original byte bound" })
    if (Buffer.byteLength(JSON.stringify(values), "utf8") > 32 * 1048576)
      ctx.addIssue({ code: "custom", message: "Memory quarantine exceeds its serialized byte bound" })
  })
