import { createHash } from "node:crypto"
import path from "node:path"
import { Option, Schema } from "effect"
import z from "zod"
import { Reconciliation } from "../voice/reconciliation-schema"

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const key = (value: string) =>
  process.platform === "win32" ? path.resolve(value).replaceAll("\\", "/").toLowerCase() : path.resolve(value)
export const reconciliation = z.unknown().transform((raw, ctx) => {
  const value = Schema.decodeUnknownOption(Reconciliation, { onExcessProperty: "error" })(raw)
  if (Option.isSome(value)) return value.value
  ctx.addIssue({ code: "custom", message: "Unsupported shipped voice reconciliation state" })
  return z.NEVER
})
export const voice = z
  .object({
    format: z.literal("raya.voice-reconciliation-evidence"),
    version: z.literal(1),
    activation: z.literal("inert"),
    states: z
      .array(
        z
          .object({
            namespace: z.union([z.literal("primary"), digest]),
            data: absolute,
            storage: absolute,
            original: z.string().max(16_384),
            state: reconciliation,
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576)
      ctx.addIssue({ code: "custom", message: "Voice reconciliation evidence exceeds aggregate bound" })
    if (new Set(value.states.map((item) => key(item.storage))).size !== value.states.length)
      ctx.addIssue({ code: "custom", message: "Duplicate voice reconciliation namespace" })
    for (const item of value.states) {
      const raw = (() => {
        try {
          return JSON.parse(item.original)
        } catch (err) {
          return undefined
        }
      })()
      const parsed = reconciliation.safeParse(raw)
      if (
        !parsed.success ||
        JSON.stringify(parsed.data) !== JSON.stringify(item.state) ||
        Buffer.byteLength(item.original) > 16_384
      )
        ctx.addIssue({ code: "custom", message: "Voice reconciliation original state differs" })
    }
  })
export const voiceReconciliation = z
  .object({
    kind: z.literal("voice-reconciliation"),
    component: z.literal("voice"),
    componentDigest: digest,
    namespace: z.union([z.literal("primary"), digest]),
    data: absolute,
    storage: absolute,
    selector: z.literal("raya/voice/usage-reconciliation/v1.json"),
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z.number().int().safe().nonnegative().max(16_384),
    digest,
    rawBytesPreserved: z.literal(true),
    restoration: z.literal("inert-original-no-settlement"),
    activation: z.literal("inert"),
  })
  .strict()
export const voiceDigest = (value: z.output<typeof voice>) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
