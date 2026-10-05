import z from "zod"
import path from "node:path"
import { exports } from "./profile-exports"
import { identity, references } from "./profile-workspaces"
import { storeContent } from "./profile-store-content"
import { contents } from "./profile-composers"
import { references as outputReferences } from "./profile-outputs"
export function schema<T extends readonly string[]>(tables: T) {
  const scalar = z.union([z.string().max(16_777_216), z.number().finite(), z.null()])
  const sql = z
    .array(
      z
        .object({
          table: z.custom<T[number]>((value) => tables.some((table) => table === value)),
          columns: z
            .array(
              z
                .string()
                .regex(/^[a-z][a-z0-9_]*$/)
                .max(128),
            )
            .min(1)
            .max(256),
          rows: z.array(z.array(scalar).max(256)).max(1_000_000),
        })
        .strict()
        .transform((item) =>
          item.table !== "session"
            ? item
            : {
                ...item,
                rows: item.rows.map((row) =>
                  row.map((value, index) => (["permission", "share_url"].includes(item.columns[index]) ? null : value)),
                ),
              },
        ),
    )
    .max(64)
  const source = z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => {
      try {
        identity(value)
        return true
      } catch {
        return false
      }
    }, "Store source must be absolute")
  const id = z.string().regex(/^[a-f0-9]{64}$/)
  const stores = z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("absent"), id, source }).strict(),
        z.object({ kind: z.literal("empty"), id, source, schema: id }).strict(),
        z
          .object({
            kind: z.literal("raya"),
            id,
            source,
            schema: id,
            sql,
            workspaces: z.array(source).max(10_000),
            content: storeContent.optional(),
          })
          .strict(),
        z.object({ kind: z.literal("session-export"), id, source, schema: id, evidence: exports }).strict(),
      ]),
    )
    .max(64)
    .superRefine((items, ctx) => {
      if (new Set(items.map((item) => item.id)).size !== items.length)
        ctx.addIssue({ code: "custom", message: "Duplicate store identity" })
      for (const item of items)
        if (item.kind === "raya") {
          if (item.content && identity(item.content.source.data) !== path.posix.dirname(identity(item.source)))
            ctx.addIssue({ code: "custom", message: "Store content differs from its physical database namespace" })
          if (item.content) {
            try {
              const drafts = contents(item.sql)
              if (drafts && JSON.stringify(drafts) !== JSON.stringify(item.content.composers))
                throw new Error("Independent composer content differs from its source SQL")
              if (
                item.content.composers?.entries.some(
                  (entry) =>
                    !item.workspaces.some((workspace) => identity(entry.identity.workspace) === identity(workspace)),
                )
              )
                throw new Error("Independent composer workspace is not declared by its store")
              const table = item.sql.find((table) => table.table === "session")
              const sessions = new Set(table?.rows.map((row) => row[table.columns.indexOf("id")]))
              if (item.content.notes.reverts.some((note) => !sessions.has(note.session)))
                throw new Error("Independent note lacks its own session")
              if (
                JSON.stringify(outputReferences(item.sql)) !==
                JSON.stringify(
                  item.content.outputs.bindings.map(({ root: _root, name: _name, state: _state, ...ref }) => ref),
                )
              )
                throw new Error("Independent output bindings differ from their source SQL")
            } catch {
              ctx.addIssue({ code: "custom", message: "Store content disagrees with its independent SQL" })
            }
          }
          if (
            new Set(item.sql.map((table) => table.table)).size !== item.sql.length ||
            item.sql.length !== tables.length
          )
            ctx.addIssue({ code: "custom", message: "Incomplete store table inventory" })
          if (item.sql.some((table) => table.rows.some((row) => row.length !== table.columns.length)))
            ctx.addIssue({ code: "custom", message: "Store row differs from columns" })
          try {
            const actual = references(item.sql).map(identity).sort()
            const declared = item.workspaces.map(identity).sort()
            if (JSON.stringify(actual) !== JSON.stringify(declared))
              ctx.addIssue({ code: "custom", message: "Store workspace inventory disagrees with SQL" })
          } catch {
            ctx.addIssue({ code: "custom", message: "Invalid store workspace reference" })
          }
        }
      if (
        items.reduce(
          (sum, item) =>
            sum + (item.kind === "raya" && item.content ? Buffer.byteLength(JSON.stringify(item.content)) : 0),
          0,
        ) >
        96 * 1024 * 1024
      )
        ctx.addIssue({ code: "custom", message: "Combined independent content exceeds supported bytes" })
    })

  return { stores, sql }
}
