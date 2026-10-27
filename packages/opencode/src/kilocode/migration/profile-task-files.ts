import { createHash } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import * as TaskFiles from "../tool/task-files-schema"
import { identity } from "./profile-workspace-identity"

export type Table = {
  readonly table: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly (string | number | null)[])[]
}
export type Components = {
  readonly json: readonly { readonly path: string; readonly value: string }[]
  readonly sql?: readonly Table[]
}
export type Entry = {
  path: string
  binding: TaskFiles.Binding
  relation: "bound" | "unpublished"
}

export function filename(value: string) {
  return /^raya\/task-files\/[a-f0-9]{64}\.json$/.test(value)
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const decode = (value: unknown) => Schema.decodeUnknownSync(TaskFiles.Binding)(value, { onExcessProperty: "error" })
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Correlate immutable declarations with their actual SQL children, never metadata alone. */
export function collect(content: Components): Entry[] {
  const selected = content.json.filter((item) => item.path.startsWith("raya/task-files/"))
  if (selected.length > 1000) throw new Error("Portable Task file scopes exceed the 1000-entry bound")
  const tables = content.sql?.filter((table) => table.table === "session") ?? []
  const marked = tables.some((table) => {
    const column = table.columns.indexOf("metadata")
    if (column < 0) return false
    return table.rows.some((row) => {
      const raw = row[column]
      if (typeof raw !== "string") return false
      try {
        const value: unknown = JSON.parse(raw)
        return object(value) && Object.hasOwn(value, TaskFiles.key)
      } catch {
        if (raw.includes(`"${TaskFiles.key}"`)) throw new Error("Portable Task metadata is malformed")
        return false
      }
    })
  })
  if (!selected.length && !marked) return []
  if (tables.length > 1 || (selected.length && tables.length !== 1))
    throw new Error("Portable Task file scopes lack one exact session table")
  const table = tables[0]
  const sessions = new Map<string, { parent: string | null; directory: string; metadata: Record<string, unknown> }>()
  if (table) {
    const columns = ["id", "parent_id", "directory", "metadata"].map((name) => table.columns.indexOf(name))
    if (columns.some((column) => column < 0)) throw new Error("Portable Task session columns are incomplete")
    for (const row of table.rows) {
      const id = row[columns[0]]
      const parent = row[columns[1]]
      const directory = row[columns[2]]
      const raw = row[columns[3]]
      if (
        typeof id !== "string" ||
        sessions.has(id) ||
        (parent !== null && typeof parent !== "string") ||
        typeof directory !== "string" ||
        (raw !== null && typeof raw !== "string")
      )
        throw new Error("Portable Task session identity is invalid")
      const metadata: unknown = raw === null ? {} : JSON.parse(raw)
      if (!object(metadata)) throw new Error("Portable Task session metadata is invalid")
      sessions.set(id, { parent, directory, metadata })
    }
  }
  const records = new Map<string, Entry>()
  for (const item of selected) {
    if (!filename(item.path) || Buffer.byteLength(item.value) > 196608)
      throw new Error("Portable Task file scope path or byte bound is invalid")
    const binding = decode(JSON.parse(item.value))
    if (item.path !== `raya/task-files/${hash(binding.child)}.json` || records.has(binding.child))
      throw new Error("Portable Task file scope hash or identity differs")
    const api =
      /^[a-z]:[\\/]/i.test(binding.directory) || binding.directory.startsWith("\\\\") ? path.win32 : path.posix
    if (!api.isAbsolute(binding.directory) || binding.declared.length !== binding.canonical.length)
      throw new Error("Portable Task file scope has an invalid directory or file inventory")
    for (const [index, file] of binding.declared.entries()) {
      const expected = api.join(binding.directory, ...file.split(/[\\/]/))
      if (identity(expected) !== identity(binding.canonical[index]))
        throw new Error("Portable Task canonical file differs from its unchanged declaration")
    }
    const session = sessions.get(binding.child)
    if (!session) {
      records.set(binding.child, { path: item.path, binding, relation: "unpublished" })
      continue
    }
    if (
      session.parent !== binding.parent ||
      !sessions.has(binding.parent) ||
      identity(session.directory) !== identity(binding.directory) ||
      !isDeepStrictEqual(decode(session.metadata[TaskFiles.key]), binding)
    )
      throw new Error("Portable Task file scope disagrees with its original session")
    records.set(binding.child, { path: item.path, binding, relation: "bound" })
  }
  for (const [id, session] of sessions) {
    if (!Object.hasOwn(session.metadata, TaskFiles.key)) continue
    const marked = decode(session.metadata[TaskFiles.key])
    if (marked.child !== id || records.get(id)?.relation !== "bound")
      throw new Error("Portable Task metadata lacks its immutable file scope")
  }
  return [...records.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function classify(file: string, raw: string, content: Components) {
  const found = collect(content).find((item) => item.path === file)
  if (!found || content.json.find((item) => item.path === file)?.value !== raw) return undefined
  return found.relation === "bound" ? ("task-files" as const) : ("task-files-orphan" as const)
}
