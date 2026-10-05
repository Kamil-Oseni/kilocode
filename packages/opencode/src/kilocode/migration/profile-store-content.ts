import path from "node:path"
import z from "zod"
import { composers, collectComposers } from "./profile-composers"
import { notes, collectNotes } from "./profile-notes"
import { outputs, collectOutputs } from "./profile-outputs"
import { assertWorking, lookup, type Working } from "./profile-image"
import { identity } from "./profile-workspaces"

const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file))
export const storeContent = z
  .object({
    version: z.literal(1),
    source: z.object({ data: absolute, storage: absolute }).strict(),
    composers: composers.optional(),
    notes,
    outputs,
    reviewOnly: z.literal(true),
    activation: z.literal("held"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (identity(value.source.storage) !== identity(path.join(value.source.data, "storage")))
      ctx.addIssue({ code: "custom", message: "Store content storage differs from its data namespace" })
    if (
      value.notes.reverts.some((item) => identity(item.root) !== identity(value.source.data)) ||
      value.notes.plans.some((item) => item.scope === "data" && identity(item.root) !== identity(value.source.data)) ||
      value.outputs.files.some((item) => identity(item.root) !== identity(value.source.data)) ||
      value.outputs.bindings.some((item) => identity(item.root) !== identity(value.source.data))
    )
      ctx.addIssue({ code: "custom", message: "Store content escaped its independent data namespace" })
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Store content exceeds supported bytes" })
  })

type Sql = { table: string; columns: string[]; rows: (string | number | null)[][] }[]
type Store = { kind: string; source: string; sql?: Sql; workspaces?: string[] }

/** Bind only unique exact physical namespaces declared by actual authenticated Global scopes. */
export async function collectStoreContent(token: Working, stores: readonly Store[], primary: string) {
  const image = assertWorking(token)
  const databases = [primary, ...stores.filter((store) => store.kind === "raya").map((store) => store.source)]
  const namespaces = [
    ...new Map(image.namespaces.map((item) => [identity(item.original.data), item.original.data])).values(),
  ]
  const selected = []
  const budget = { bytes: 0 }
  for (const store of stores) {
    if (store.kind !== "raya" || !store.sql || !store.workspaces) {
      selected.push(store)
      continue
    }
    const matches = namespaces.filter((data) => identity(data) === identity(path.dirname(store.source)))
    if (matches.length !== 1) throw new Error("Extra store lacks an exact authenticated data namespace binding")
    const data = matches[0]
    if (databases.filter((file) => identity(path.dirname(file)) === identity(data)).length !== 1)
      throw new Error("Independent databases share an ambiguous content namespace")
    const storage = path.join(data, "storage")
    const staged = lookup(token, storage)
    lookup(token, data)
    const content = storeContent.parse({
      version: 1,
      source: { data, storage },
      composers: await collectComposers(store.sql, staged),
      notes: await collectNotes(token, { data: [data], workspaces: store.workspaces, sql: store.sql }),
      outputs: await collectOutputs(token, { data: [data], sql: store.sql }),
      reviewOnly: true,
      activation: "held",
    })
    budget.bytes += Buffer.byteLength(JSON.stringify(content))
    if (budget.bytes > 96 * 1024 * 1024) throw new Error("Combined independent content exceeds supported bytes")
    selected.push({ ...store, content })
  }
  assertWorking(token)
  return selected
}
