import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"

const number = z.number().finite().nonnegative()
const id = z.string().max(4096).nullable()
const state = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    scope: z.literal("project"),
    autoInject: z.boolean(),
    autoConsolidate: z.boolean(),
    verbose: z.boolean(),
    capture: z
      .object({
        mode: z.literal("selective"),
        turnClose: z.boolean(),
        explicit: z.boolean(),
        maxOpsPerRun: number.min(1),
        minIntervalMs: number.min(1000),
        timeoutMs: number.min(1000),
      })
      .strict(),
    stats: z
      .object({
        lastInjectedAt: number.nullable(),
        lastInjectedBytes: number,
        lastInjectedTokens: number,
        lastInjectedSessionID: id,
        lastTypedConsolidationAt: number.nullable(),
        lastSessionSavedAt: number.nullable(),
        lastConsolidatedMessageID: id,
        lastConsolidationCost: number,
        lastConsolidationTokens: number,
        lastOperationCount: number,
        lastRecallAt: number.nullable(),
        lastRecallCount: number,
        lastRecallSessionID: id,
      })
      .strict(),
  })
  .strict()
const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
export const memoryManifest = z
  .object({
    kind: z.literal("kilo-memory"),
    version: z.literal(1),
    display: z.string().min(1).max(240),
    canonical: absolute,
    folder: z.string().min(1).max(240),
    createdAt: z.string().datetime(),
  })
  .strict()
const stable = (input: unknown): unknown =>
  Array.isArray(input)
    ? input.map(stable)
    : input && typeof input === "object"
      ? Object.fromEntries(
          Object.entries(input)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, stable(value)]),
        )
      : input
export const memoryState = state.superRefine((value, ctx) => {
  // The genuine destination review guard persists autoInject:false while the ordinary parser defaults it to true.
  const parsed = { ...MemorySchema.persist(MemorySchema.parse(value)), autoInject: value.autoInject }
  if (JSON.stringify(stable(value)) !== JSON.stringify(stable(parsed)))
    ctx.addIssue({ code: "custom", message: "Memory state is not a lossless shipped state" })
})
export const memoryPrior = z
  .object({
    workspace: absolute,
    state: memoryState,
    decisions: z
      .string()
      .max(1048576)
      .refine((value) => MemoryRedact.text(value) === value),
  })
  .strict()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const content = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state"), value: memoryState }).strict(),
  z.object({ kind: z.literal("manifest"), value: memoryManifest }).strict(),
  z.object({ kind: z.literal("prior"), value: memoryPrior }).strict(),
])
export const memoryLineage = z
  .object({
    version: z.literal(1),
    records: z
      .array(
        z
          .object({
            source: absolute,
            sourceDigest: digest,
            content,
          })
          .strict(),
      )
      .max(64),
    activation: z.literal("inert"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.records.map((item) => item.source + ":" + item.sourceDigest)).size !== value.records.length)
      ctx.addIssue({ code: "custom", message: "Duplicate memory lineage" })
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Memory lineage exceeds bound" })
    if (MemoryRedact.text(JSON.stringify(value)) !== JSON.stringify(value))
      ctx.addIssue({ code: "custom", message: "Memory lineage contains credential-shaped content" })
  })
export function memoryRecord(source: string, bytes: string, value: z.output<typeof content>) {
  return { source, sourceDigest: createHash("sha256").update(bytes).digest("hex"), content: value }
}
