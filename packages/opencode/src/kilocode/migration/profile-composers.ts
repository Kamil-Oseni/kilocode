import path from "node:path"
import { DraftLegacy, DraftSchemas } from "../session/composer-codec"
import z from "zod"
import { read } from "./profile-file"
import { mapper } from "./profile-workspaces"

/** Content and revision evidence only; SQL control, cursors and physical-root proofs are never imported. */
export const composers = z
  .object({ version: z.literal(1), entries: z.array(DraftSchemas.entry).max(128) })
  .strict()
  .superRefine((value, ctx) => {
    try {
      DraftLegacy.checked(value)
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid portable composer content" })
    }
  })

type Table = { table: string; columns: string[]; rows: (string | number | null)[][] }

/** Old archives may carry SQL content; validate it before deliberately omitting its physical owners. */
export function contents(tables: readonly Table[]) {
  const control = tables.find((table) => table.table === "raya_composer_control")
  const drafts = tables.find((table) => table.table === "raya_composer_draft")
  if (!control?.rows.length) {
    if (drafts?.rows.length) throw new Error("Portable composer rows lack their source journal")
    return undefined
  }
  if (control.rows.length !== 1 || control.rows[0][control.columns.indexOf("phase")] !== "active")
    throw new Error("Portable composer journal is not settled")
  if (!drafts) throw new Error("Portable composer journal lacks its content table")
  const entries = drafts.rows.map((row) => {
    const get = (key: string) => row[drafts.columns.indexOf(key)]
    const record = get("record")
    if (typeof record !== "string") throw new Error("Portable composer record is missing")
    const entry = DraftSchemas.entry.parse(JSON.parse(record))
    const size = entry.content === null ? 0 : Buffer.byteLength(JSON.stringify(entry.content))
    const bytes =
      Buffer.byteLength(record) -
      size +
      Buffer.byteLength(
        JSON.stringify([
          DraftLegacy.id(entry.identity),
          entry.identity.workspace,
          entry.identity.projectID ?? "",
          entry.identity.box,
        ]),
      )
    if (
      !Number.isSafeInteger(get("sequence")) ||
      Number(get("sequence")) < 1 ||
      get("content_bytes") !== size ||
      get("metadata_bytes") !== bytes ||
      get("id") !== DraftLegacy.id(entry.identity) ||
      get("workspace") !== entry.identity.workspace ||
      get("project") !== (entry.identity.projectID ?? "") ||
      get("box") !== entry.identity.box
    )
      throw new Error("Portable composer row identity disagrees with its content")
    return entry
  })
  return composers.parse({ version: 1, entries })
}

export async function collectComposers(tables: readonly Table[], storage: string) {
  const active = contents(tables)
  if (active) return active
  const selected = async (key: readonly string[]) =>
    read(path.join(storage, ...key) + ".json", 32 * 1024 * 1024, 32 * 1024 * 1024).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
  const source = await selected(DraftLegacy.key)
  const marker = await selected(DraftLegacy.mark)
  if (marker && (!source || JSON.parse(marker.value)?.version !== 1))
    throw new Error("Portable legacy composer initialization is inconsistent")
  if (!source) return undefined
  return composers.parse(JSON.parse(source.value))
}

export function remapComposers(value: z.infer<typeof composers>, mappings: ReadonlyMap<string, string>) {
  const translate = mapper(mappings)
  return composers.parse({
    version: 1,
    entries: value.entries.map((entry) => ({
      ...entry,
      identity: { ...entry.identity, workspace: translate(entry.identity.workspace) },
      // A request digest includes the source identity. Preserve it only in the inert original archive.
      receipt: undefined,
    })),
  })
}
