import path from "node:path"
import { eq, or, sql } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"

function syntax(directory: string) {
  return /^[a-z]:[\\/]/i.test(directory) || directory.startsWith("\\\\") ? path.win32 : path.posix
}

/** Derive the global display path from the directory's volume, independent of process cwd. */
export function globalPath(directory: string) {
  const api = syntax(directory)
  return api.relative(api.parse(directory).root, directory).replaceAll("\\", "/")
}

/** Exact physical directory spelling compatibility, without admitting siblings or descendants. */
export function exact(directory: string) {
  const api = syntax(directory)
  if (api !== path.win32) return eq(SessionTable.directory, directory)
  const value = api.normalize(directory).replaceAll("\\", "/").toLowerCase()
  return eq(sql`lower(replace(${SessionTable.directory}, ${"\\"}, ${"/"}))`, value)
}

/** Compare literal directory components rather than SQL LIKE patterns or saved display paths. */
export function descendants(directory: string) {
  const api = syntax(directory)
  const value = api.normalize(directory).replaceAll("\\", "/").replace(/\/$/, "")
  const prefix = `${api === path.win32 ? value.toLowerCase() : value}/`
  const column =
    api === path.win32
      ? sql`lower(replace(${SessionTable.directory}, ${"\\"}, ${"/"}))`
      : sql`${SessionTable.directory}`
  return or(eq(column, prefix.slice(0, -1)), sql`substr(${column}, 1, ${prefix.length}) = ${prefix}`)!
}

/** Recognize only the current global-directory view; unrelated explicit path queries retain their meaning. */
export function directoryQuery<T extends { directory?: string; path?: string; scope?: "project" }>(
  input: T | undefined,
  project: { id: string; worktree: string },
): (Omit<T, "path"> & { path?: string }) | undefined {
  if (!input || project.id !== "global" || project.worktree !== "/" || input.scope === "project") return input
  if (!input.directory || input.path === undefined) return input
  const api = syntax(input.directory)
  if (!api.isAbsolute(input.directory)) return input
  const normalize = (value: string) => {
    const result = api.normalize(value).replaceAll("\\", "/")
    return api === path.win32 ? result.toLowerCase() : result
  }
  const query = normalize(input.path)
  if (![input.directory, globalPath(input.directory)].some((value) => normalize(value) === query)) return input
  return { ...input, path: undefined }
}
