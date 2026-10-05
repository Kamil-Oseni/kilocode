import path from "node:path"
import z from "zod"
import { globalPath } from "../session/directory-query"

type Cell = string | number | null
type Table = { table: string; columns: string[]; rows: Cell[][] }

function syntax(file: string) {
  if (/^[a-z]:[\\/]/i.test(file) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(file)) return path.win32
  if (file.startsWith("/")) return path.posix
  throw new Error("Declared portable workspace reference must be absolute")
}

/** Source storage may use Windows forward slashes even when the destination uses another platform. */
export function identity(file: string) {
  if (!file || file.length > 4096 || file.includes("\0")) throw new Error("Invalid portable workspace reference")
  const api = syntax(file)
  const normalized = api.normalize(file)
  return api === path.win32 ? normalized.replaceAll("\\", "/").toLowerCase() : normalized
}

const arrays = z.array(z.string().min(1).max(4096)).max(10_000)
const columns: Readonly<Record<string, readonly string[]>> = {
  project: ["worktree"],
  project_directory: ["directory"],
  session: ["directory"],
  workspace: ["directory"],
}

function selected(table: Table, value: Cell, column: string, row: readonly Cell[]): string[] {
  // The shipped non-Git project uses a sentinel, not a filesystem root to migrate.
  if (
    table.table === "project" &&
    column === "worktree" &&
    value === "/" &&
    row[table.columns.indexOf("id")] === "global"
  )
    return []
  if (table.table === "project" && column === "sandboxes") {
    if (typeof value !== "string") throw new Error("Portable project sandboxes must be a serialized directory array")
    return arrays.parse(JSON.parse(value)).map((file) => {
      identity(file)
      return file
    })
  }
  if (!columns[table.table]?.includes(column) && !(table.table === "session" && column === "path")) return []
  if (value === null && (table.table === "workspace" || column === "path")) return []
  if (value === "" && table.table === "session") return []
  if (typeof value !== "string") throw new Error("Portable directory reference must be a string")
  if (column === "path" && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) return []
  identity(value)
  return [value]
}

/** Enumerate only shipped directory fields. Opaque plugin extra and conversation JSON are never interpreted. */
export function references(tables: readonly Table[]) {
  const values = tables.flatMap((table) =>
    table.rows.flatMap((row) => row.flatMap((value, index) => selected(table, value, table.columns[index], row))),
  )
  return [...new Map(values.map((file) => [identity(file), file])).values()]
}

/** Map declared references before any target directory is reserved; never replace arbitrary strings. */
export function mapper(mappings: ReadonlyMap<string, string>) {
  const entries = [...mappings].map(([source, target]) => ({ source, target, key: identity(source) }))
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw new Error("Portable source workspace mappings collide")
  return (file: string) => {
    const normalized = identity(file)
    const matched = entries
      .filter((entry) => normalized === entry.key || normalized.startsWith(`${entry.key.replace(/\/$/, "")}/`))
      .sort((a, b) => b.key.length - a.key.length)[0]
    if (!matched) throw new Error("Unmapped absolute workspace path in portable SQL")
    const relative = syntax(file).relative(matched.source, file)
    return path.join(matched.target, ...relative.split(/[\\/]/).filter(Boolean))
  }
}

function relations(table: Table, rows: Cell[][]) {
  if (table.table !== "project_directory") return rows
  const project = table.columns.indexOf("project_id")
  const directory = table.columns.indexOf("directory")
  const time = table.columns.indexOf("time_created")
  const values = new Map<string, { row: Cell[]; source: string }>()
  for (const [index, row] of rows.entries()) {
    const original = table.rows[index][directory]
    if (typeof row[project] !== "string" || typeof row[directory] !== "string" || typeof original !== "string")
      throw new Error("Portable project directory relation is invalid")
    const source = identity(original)
    const key = JSON.stringify([row[project], row[directory]])
    const prior = values.get(key)
    if (!prior) {
      values.set(key, { row, source })
      continue
    }
    if (prior.source !== source) throw new Error("Portable project directory mappings collide")
    if (row.some((value, column) => column !== directory && column !== time && value !== prior.row[column]))
      throw new Error("Portable project directory alias metadata conflicts")
    if (time < 0) continue
    const first = prior.row[time]
    const next = row[time]
    if (
      typeof first !== "number" ||
      !Number.isSafeInteger(first) ||
      first < 0 ||
      typeof next !== "number" ||
      !Number.isSafeInteger(next) ||
      next < 0
    )
      throw new Error("Portable project directory alias creation time is invalid")
    // Canonical re-admission adds an equivalent spelling later. Keep the first
    // association creation; both source rows and timestamps remain inert evidence.
    prior.row[time] = Math.min(first, next)
  }
  return [...values.values()].map((value) => value.row)
}

export function remap(tables: readonly Table[], mappings: ReadonlyMap<string, string>) {
  const translate = mapper(mappings)
  references(tables).forEach(translate)
  const projects = new Map<string, string>()
  const global = tables.some(
    (table) =>
      table.table === "project" &&
      table.rows.some(
        (row) => row[table.columns.indexOf("id")] === "global" && row[table.columns.indexOf("worktree")] === "/",
      ),
  )
  for (const table of tables)
    if (table.table === "project")
      for (const row of table.rows) {
        const id = row[table.columns.indexOf("id")]
        const worktree = row[table.columns.indexOf("worktree")]
        if (id === "global" && worktree === "/") continue
        if (typeof id === "string" && typeof worktree === "string") projects.set(id, translate(worktree))
      }
  return tables.map((table) => ({
    ...table,
    rows: relations(
      table,
      table.rows.map((row) =>
        row.map((value, index) => {
          const column = table.columns[index]
          if (
            (table.table === "project" && column === "commands") ||
            (table.table === "workspace" && column === "extra")
          )
            return null
          if (table.table === "project" && column === "sandboxes")
            return JSON.stringify(selected(table, value, column, row).map(translate))
          if (selected(table, value, column, row).length) return translate(String(value))
          if (table.table === "session" && column === "path" && typeof value === "string" && value !== "") {
            const id = row[table.columns.indexOf("project_id")]
            const directory = row[table.columns.indexOf("directory")]
            // The list compatibility boundary reads both legacy absolute paths and
            // volume-relative paths without depending on the restore process cwd.
            if (id === "global" && global && typeof directory === "string" && directory)
              return globalPath(translate(directory))
            const worktree = typeof id === "string" ? projects.get(id) : undefined
            if (!worktree || typeof directory !== "string" || !directory)
              throw new Error("Portable relative session path lacks a declared project directory")
            return path.relative(worktree, translate(directory)).replaceAll("\\", "/")
          }
          return value
        }),
      ),
    ),
  }))
}
