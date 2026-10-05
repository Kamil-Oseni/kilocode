import path from "node:path"
import { createHash } from "node:crypto"
import z from "zod"
import { receipt } from "../../../../kilo-memory/src/storage/review-schema"
import type { snapshot } from "./profile-bundle"
import { identity } from "./profile-workspaces"

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const fields = {
  bundle: z.string().uuid(),
  hold: z.string().uuid(),
  workspaces: z.record(absolute, absolute),
  reconnectCredentials: z.literal(true),
  uncertainWork: z.literal("held-no-replay"),
}
export const ReviewSchema = z
  .discriminatedUnion("version", [
    z.object({ format: z.literal("raya.restore-review"), version: z.literal(1), ...fields }).strict(),
    z
      .object({
        format: z.literal("raya.restore-review"),
        version: z.literal(2),
        ...fields,
        storesAt: z.number().int().safe().nonnegative(),
        primaries: z.array(absolute).max(128),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const entries = Object.entries(value.workspaces)
    if (
      entries.length > 128 ||
      new Set(entries.map(([source]) => identity(source))).size !== entries.length ||
      new Set(entries.map(([, destination]) => identity(destination))).size !== entries.length
    )
      ctx.addIssue({ code: "custom", message: "Restore review workspace inventory differs" })
    if (
      value.version === 2 &&
      (new Set(value.primaries.map(identity)).size !== value.primaries.length ||
        value.primaries.some((source) => !entries.some(([key]) => identity(key) === identity(source))))
    )
      ctx.addIssue({ code: "custom", message: "Restore review primary inventory differs" })
    if (Buffer.byteLength(JSON.stringify(value)) > 65536)
      ctx.addIssue({ code: "custom", message: "Restore review exceeds byte bound" })
  })
export function renderReview(input: {
  bundle: string
  hold: string
  mapping: ReadonlyMap<string, string>
  storesAt: number
  primaries: readonly string[]
}) {
  return ReviewSchema.parse({
    format: "raya.restore-review",
    version: 2,
    bundle: input.bundle,
    hold: input.hold,
    workspaces: Object.fromEntries(input.mapping),
    reconnectCredentials: true,
    uncertainWork: "held-no-replay",
    storesAt: input.storesAt,
    primaries: [...input.primaries],
  })
}
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const reviewContext = z
  .object({
    data: absolute,
    reviewText: z.string().max(65536),
    receiptText: z.string().max(8192),
    receipt: z
      .object({
        source: absolute,
        dev: z.string().regex(/^\d+$/),
        ino: z.string().regex(/^\d+$/),
        bytes: z.number().int().safe().nonnegative().max(8192),
        digest,
      })
      .strict(),
  })
  .strict()
/** Inert writer provenance never approves or releases a destination hold. */
export function validateReview(context: z.output<typeof reviewContext>, original: z.output<typeof snapshot>) {
  const value = reviewContext.parse(context)
  const review = ReviewSchema.parse(JSON.parse(value.reviewText))
  const saved = receipt.parse(JSON.parse(value.receiptText))
  if (
    saved.id !== review.hold ||
    identity(value.receipt.source) !== identity(path.join(value.data, "storage", "raya", "restore-hold.json")) ||
    Buffer.byteLength(value.receiptText) !== value.receipt.bytes ||
    createHash("sha256").update(value.receiptText).digest("hex") !== value.receipt.digest
  )
    throw new Error("Restore review lacks exact held receipt identity")
  const keys = Object.keys(review.workspaces).map(identity).sort()
  if (
    review.bundle !== original.id ||
    JSON.stringify(keys) !== JSON.stringify(original.workspaces.map(identity).sort())
  )
    throw new Error("Restore review differs from original workspace inventory")
  if (
    review.version === 2 &&
    review.primaries.some(
      (source) =>
        !original.artifacts?.repositories.some(
          (repo) => repo.workspace && identity(repo.workspace) === identity(source),
        ),
    )
  )
    throw new Error("Restore review primary lacks original Git repository")
  return review
}
export function validateRestoredReceipts(
  contexts: readonly (z.output<typeof reviewContext> | undefined)[],
  files: readonly { path: string; dev: string; ino: string; bytes: number; digest: string }[],
) {
  for (const context of contexts) {
    if (!context) continue
    const matches = files.filter((file) => identity(file.path) === identity(context.receipt.source))
    if (
      matches.length !== 1 ||
      matches[0].dev !== context.receipt.dev ||
      matches[0].ino !== context.receipt.ino ||
      matches[0].bytes !== context.receipt.bytes ||
      matches[0].digest !== context.receipt.digest
    )
      throw new Error("Restore review receipt is absent from exact native ledger")
  }
}
