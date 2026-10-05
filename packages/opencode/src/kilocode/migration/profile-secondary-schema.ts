import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { artifacts } from "./profile-artifacts"
import { memory } from "./profile-memory"
import { identity } from "./profile-workspaces"

const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value))
export const namespaceID = (data: string, storage: string) =>
  createHash("sha256")
    .update(JSON.stringify([identity(data), identity(storage)]))
    .digest("hex")

export function artifactUsage(value: z.output<typeof artifacts> | undefined) {
  const inventories = value
    ? [
        ...value.repositories.map((item) => ({ files: item.files, directories: item.directories })),
        ...value.repositories.flatMap((item) => (item.working ? [item.working] : [])),
        ...value.worktrees.flatMap((item) => [
          { files: item.files, directories: item.directories },
          { files: item.admin, directories: item.adminDirectories },
        ]),
      ]
    : []
  return {
    bytes:
      (value?.snapshotScaffolds ? Buffer.byteLength(JSON.stringify(value.snapshotScaffolds)) : 0) +
      inventories.reduce(
        (sum, item) =>
          sum +
          item.files.reduce(
            (sum, file) =>
              sum +
              Buffer.from(file.bytes, "base64").length +
              (file.projection ? Buffer.byteLength(JSON.stringify(file.projection)) : 0),
            0,
          ),
        0,
      ),
    nodes:
      inventories.reduce((sum, item) => sum + item.files.length + item.directories.length, 0) +
      inventories.reduce(
        (sum, item) => sum + item.files.reduce((sum, file) => sum + (file.projection?.ledger.length ?? 0), 0),
        0,
      ) +
      (value?.repositories.reduce((sum, item) => sum + (item.working?.excluded.length ?? 0), 0) ?? 0) +
      (value?.snapshotScaffolds?.reduce((sum, item) => sum + 1 + item.children.length, 0) ?? 0),
    repositories: value?.repositories.length ?? 0,
    bindings: (value?.snapshots.length ?? 0) + (value?.worktrees.length ?? 0),
  }
}

/** These separately loaded graphs remain inactive evidence, never primary memory or Git authority. */
export const secondary = z
  .object({
    format: z.literal("raya.secondary-data"),
    version: z.literal(1),
    namespaces: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            source: z.object({ data: absolute, storage: absolute }).strict(),
            memory: z.array(memory).max(10_000),
            artifacts: artifacts.optional(),
            archives: z.array(z.string().uuid()).max(64),
          })
          .strict(),
      )
      .max(128),
    reviewOnly: z.literal(true),
    activation: z.literal("held"),
    coverage: z.literal("declared-secondary-data"),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.namespaces.map((item) => item.id)).size !== value.namespaces.length)
      ctx.addIssue({ code: "custom", message: "Duplicate secondary namespace" })
    for (const item of value.namespaces) {
      if (item.id !== namespaceID(item.source.data, item.source.storage))
        ctx.addIssue({ code: "custom", message: "Secondary namespace identity disagrees with provenance" })
      if (identity(item.source.storage) !== identity(path.join(item.source.data, "storage")))
        ctx.addIssue({ code: "custom", message: "Secondary storage differs from the loaded data namespace" })
      if (new Set(item.memory.map((item) => identity(item.workspace))).size !== item.memory.length)
        ctx.addIssue({ code: "custom", message: "Duplicate memory within secondary namespace" })
      if (new Set(item.archives).size !== item.archives.length)
        ctx.addIssue({ code: "custom", message: "Duplicate secondary archive reference" })
    }
  })
