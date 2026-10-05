import path from "node:path"
import z from "zod"
import { artifacts } from "./profile-artifacts"
import { artifactUsage } from "./profile-secondary-schema"
import { reviewContext } from "./profile-restore-review-schema"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !/[\\:\0\r\n]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== ".."),
  )
export const restoredGit = z
  .object({
    kind: z.literal("restored-git"),
    archive: z.string().uuid(),
    archiveDigest: digest,
    namespace: z.union([z.literal("primary"), digest]),
    componentDigest: digest,
    selector: z
      .object({
        route: z.enum([
          "repository-evidence",
          "repository-files",
          "repository-config",
          "snapshot-evidence",
          "worktree-evidence",
          "worktree-admin",
          "primary-tree",
          "primary-manifest",
          "worktree-commondir",
          "worktree-gitdir",
        ]),
        repository: digest,
        worktree: digest.optional(),
        path: relative,
      })
      .strict(),
    data: absolute,
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
    modified: z
      .string()
      .max(20)
      .regex(/^\d+$/)
      .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)
      .optional(),
    relationship: z.enum(["archived-bytes", "materialize-generated"]),
    activation: z.literal("inert"),
  })
  .strict()

export const restoredArtifacts = z
  .array(
    z
      .object({
        archive: z.string().uuid(),
        archiveDigest: digest,
        namespace: z.union([z.literal("primary"), digest]),
        artifacts,
        context: reviewContext.optional(),
      })
      .strict(),
  )
  .max(64)
  .superRefine((value, ctx) => {
    if (new Set(value.map((item) => item.archive + ":" + item.namespace)).size !== value.length)
      ctx.addIssue({ code: "custom", message: "Duplicate restored Git projection" })
    const totals = value.map((item) => artifactUsage(item.artifacts))
    if (
      totals.reduce((sum, item) => sum + item.bytes, 0) > 96 * 1024 * 1024 ||
      totals.reduce((sum, item) => sum + item.nodes, 0) > 20000 ||
      totals.reduce((sum, item) => sum + item.repositories, 0) > 256
    )
      ctx.addIssue({ code: "custom", message: "Restored Git projection exceeds shared bound" })
  })
