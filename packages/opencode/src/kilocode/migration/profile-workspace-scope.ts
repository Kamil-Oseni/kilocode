import { Database } from "bun:sqlite"
import z from "zod"
import { assertWorking, type Working } from "./profile-image"
import { references } from "./profile-workspaces"
import { measure } from "./profile-sql"
import { classify } from "./profile-stores"

/** Plan historical workspaces from recovered private SQLite, never from the retired source file. */
export async function workspaceScopes(token: Working) {
  const value = assertWorking(token)
  const columns: Readonly<Record<string, readonly string[]>> = {
    project: ["id", "worktree", "sandboxes"],
    project_directory: ["directory"],
    session: ["directory", "path"],
    workspace: ["directory"],
  }
  const budget = { bytes: 0 }
  const paths = new Set<string>()
  for (const store of value.stores) {
    if (!store.present) continue
    if (!store.staged) throw new Error("Present SQLite store lacks recovered workspace mapping")
    if (store.staged !== value.profile.database && (await classify(store.staged)).kind !== "raya") continue
    assertWorking(token)
    using db = new Database(store.staged, { readonly: true, strict: true })
    const tables = Object.entries(columns).map(([table, selected]) => {
      const present = db.query<{ name: string }, []>(`PRAGMA table_info('${table}')`).all()
      const names = selected.filter((name) => present.some((column) => column.name === name))
      if (!names.length) return { table, columns: [], rows: [] }
      budget.bytes += measure(db, table, names)
      if (budget.bytes > 16 * 1024 * 1024) throw new Error("Historical workspace inventory exceeds supported bytes")
      const rows = db
        .query(`SELECT ${names.map((name) => `"${name}"`).join(",")} FROM "${table}" LIMIT 100001`)
        .values()
      if (rows.length > 100_000) throw new Error("Historical workspace inventory exceeds supported rows")
      // The shipped fields above are textual or nullable; no arbitrary JSON is interpreted.
      return { table, columns: names, rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).parse(rows) }
    })
    assertWorking(token)
    for (const file of references(tables)) paths.add(file)
    if (paths.size > 128) throw new Error("Historical workspace inventory exceeds supported namespaces")
  }
  assertWorking(token)
  return Object.freeze([...paths].sort())
}
