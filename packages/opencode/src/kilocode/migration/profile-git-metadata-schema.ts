import path from "node:path"
import z from "zod"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
export const gitConfigProjection = z
  .object({
    kind: z.literal("safe-git-config"),
    sourceDigest: digest,
    sourceBytes: z.number().int().nonnegative().max(262144),
    supported: z.boolean(),
    ledger: z
      .array(
        z
          .object({
            line: z.number().int().min(0).max(19999),
            reason: z.enum([
              "formatting",
              "section-formatting",
              "canonical-safe-value",
              "omitted-personal-identity",
              "omitted-connection-or-execution",
              "omitted-source-platform-option",
              "unsupported",
            ]),
          })
          .strict(),
      )
      .max(20000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.ledger.length > value.sourceBytes + 1 ||
      value.ledger.some((line, index) => line.line !== index) ||
      value.supported !== value.ledger.every((line) => line.reason !== "unsupported")
    )
      ctx.addIssue({ code: "custom", message: "Git config projection ledger differs" })
  })
export const gitMetadata = z
  .object({
    kind: z.literal("git-metadata"),
    namespace: z.union([z.literal("primary"), digest]),
    componentDigest: digest,
    selector: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("config"), id: digest, path: z.enum(["config", "config.worktree"]) }).strict(),
      z.object({ kind: z.literal("pointer"), workspace: absolute, common: digest }).strict(),
      z
        .object({
          kind: z.literal("admin"),
          workspace: absolute,
          common: digest,
          admin: absolute,
          path: z.enum(["HEAD", "index", "logs/HEAD", "ORIG_HEAD", "commondir", "gitdir"]),
        })
        .strict(),
    ]),
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(32 * 1024 * 1024),
    digest,
    projectedDigest: digest,
    transformation: z.enum(["safe-config-projection", "mapped-backlink", "inert-admin-evidence"]),
    ledger: z
      .array(
        z
          .object({
            line: z.number().int().min(0).max(19999),
            reason: z.enum([
              "formatting",
              "section-formatting",
              "canonical-safe-value",
              "omitted-personal-identity",
              "omitted-connection-or-execution",
              "omitted-source-platform-option",
            ]),
          })
          .strict(),
      )
      .max(20000),
    rawBytesPreserved: z.boolean(),
    activation: z.literal("inert"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const config = value.selector.kind === "config"
    const backlink =
      value.selector.kind === "pointer" ||
      (value.selector.kind === "admin" && ["gitdir", "commondir"].includes(value.selector.path))
    const expected = config ? "safe-config-projection" : backlink ? "mapped-backlink" : "inert-admin-evidence"
    if (
      value.transformation !== expected ||
      value.rawBytesPreserved !== (value.selector.kind === "admin") ||
      (!config && value.ledger.length !== 0) ||
      (config && value.ledger.some((line, index) => line.line !== index))
    )
      ctx.addIssue({ code: "custom", message: "Git metadata transformation differs" })
  })
