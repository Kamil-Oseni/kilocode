import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { opendir } from "node:fs/promises"
import { sql as query } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type z from "zod"
import * as TaskFiles from "../tool/task-files-schema"
import * as Files from "../task/output-scope"
import type { payload } from "./profile-bundle"
import { collect } from "./profile-task-files"
import { identity } from "./profile-workspace-identity"
import { read } from "./profile-file"

type Content = {
  json: z.output<typeof payload>["json"]
  sql: { table: string; columns: string[]; rows: (string | number | null)[][] }[]
}
const same = (left: string, right: string) => identity(left) === identity(right)

/** Rebase only declared attenuation onto the explicitly mapped, physically checked child workspace. */
export const project = Effect.fn("ProfileTaskFiles.project")(function* (input: {
  source: Content
  target: Content
  mapping: ReadonlyMap<string, string>
  stage: string
  destination: string
}) {
  const entries = collect(input.source)
  if (entries.length > 1000) throw new Error("Task file-scope restore exceeds its supported inventory")
  const fs = yield* FSUtil.Service
  const { mapper } = yield* Effect.promise(() => import("./profile-workspaces"))
  const translate = mapper(input.mapping)
  const bindings = new Map<string, TaskFiles.Binding>()
  for (const entry of entries) {
    if (entry.relation !== "bound") continue
    const saved = entry.binding
    const directory = translate(saved.directory)
    const relative = path.relative(input.destination, directory)
    const staged =
      relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    const physical = staged ? path.join(input.stage, relative) : directory
    if (!same(yield* fs.realPath(physical), physical))
      throw new Error("Restored Task workspace aliases are unsupported")
    const expected = saved.declared.map((file) => path.join(directory, ...file.split(/[\\/]/)))
    const actual = saved.declared.map((file) => path.join(physical, ...file.split(/[\\/]/)))
    const checked = yield* Files.canonical(fs, actual)
    if (checked.some((file, index) => !same(file, actual[index])))
      throw new Error("Restored Task targets changed their canonical paths")
    const future = yield* Files.canonical(fs, expected)
    if (future.some((file, index) => !same(file, expected[index])))
      throw new Error("Restored Task destination aliases are unsupported")
    const canonical = staged ? checked.map((file) => path.join(directory, path.relative(physical, file))) : future
    const binding = yield* Schema.decodeUnknownEffect(TaskFiles.Binding)({ ...saved, directory, canonical })
    bindings.set(entry.path, binding)
  }
  const sql = input.target.sql.map((table) => {
    if (table.table !== "session") return table
    const index = table.columns.indexOf("metadata")
    const id = table.columns.indexOf("id")
    const rows = table.rows.map((row) => {
      const binding = [...bindings.values()].find((item) => item.child === row[id])
      if (!binding) return row
      if (typeof row[index] !== "string") throw new Error("Restored Task session metadata is unavailable")
      const metadata = JSON.parse(row[index])
      const next = [...row]
      next[index] = JSON.stringify({ ...metadata, [TaskFiles.key]: binding })
      return next
    })
    return { ...table, rows }
  })
  const paths = new Set(entries.map((item) => item.path))
  const json = input.target.json.flatMap((item) => {
    if (!paths.has(item.path)) return [item]
    const binding = bindings.get(item.path)
    return binding ? [{ ...item, value: JSON.stringify(binding) }] : []
  })
  const target = { sql, json }
  const restored = collect(target)
  if (restored.length !== bindings.size || restored.some((entry) => entry.relation !== "bound"))
    throw new Error("Restored Task file scopes lost their original child sessions")
  return target
})

/** Read actual destination SQL/ledger against retained source and reviewed mapping; never grants or repairs. */
export const inspect = Effect.fn("ProfileTaskFiles.inspect")(function* (
  data: string,
  database?: Database.Interface,
): Effect.fn.Return<readonly TaskFiles.Binding[] | undefined, unknown> {
  const root = path.join(data, "storage", "raya", "task-files")
  const original = yield* Effect.promise(() => optional(path.join(data, "restore-source.json"), 128 * 1024 * 1024))
  if (original === undefined) {
    const directory = yield* Effect.promise(() =>
      opendir(root).catch((err: unknown) => {
        if (missing(err)) return undefined
        throw err
      }),
    )
    if (directory) {
      const present = yield* Effect.promise(async () => {
        try {
          return (await directory.read()) !== null
        } finally {
          await directory.close()
        }
      })
      if (present) throw new Error("Task file-scope review lacks original source evidence")
    }
    if (database) {
      const marked = yield* database.db.all<{ id: string }>(
        `SELECT id FROM session WHERE CASE WHEN json_valid(metadata) THEN json_type(metadata, '$."raya.task.files"') IS NOT NULL ELSE 0 END LIMIT 1`,
      )
      if (marked.length) throw new Error("Task file-scope metadata lacks original source evidence")
    }
    return undefined
  }
  const { payload } = yield* Effect.promise(() => import("./profile-bundle"))
  const { ReviewSchema } = yield* Effect.promise(() => import("./profile-restore-review-schema"))
  const source = payload.parse(JSON.parse(original.value))
  const review = ReviewSchema.parse(
    JSON.parse((yield* Effect.promise(() => read(path.join(data, "restore-review.json"), 65536))).value),
  )
  if (review.bundle !== source.id) throw new Error("Task file-scope review belongs to another source bundle")
  const entries = collect(source)
  if (entries.length === 0) return undefined
  const selected = entries.filter((entry) => entry.relation === "bound")
  if (selected.length === 0) return []
  const ids = new Set(selected.flatMap((entry) => [entry.binding.child, entry.binding.parent]))
  if (!database) throw new Error("Task file-scope review requires the selected profile database")
  const json: Content["json"] = []
  for (const entry of selected) {
    const target = path.join(root, path.basename(entry.path))
    json.push({ path: entry.path, value: (yield* Effect.promise(() => read(target, 196608))).value })
  }
  const rows = yield* database.db.all<{
    id: string
    parent_id: string | null
    directory: string
    metadata: string | null
  }>(
    query`SELECT id,parent_id,directory,metadata FROM session WHERE id IN (${query.join(
      [...ids].map((id) => query`${id}`),
      query`, `,
    )})`,
  )
  const sql = [
    {
      table: "session",
      columns: ["id", "parent_id", "directory", "metadata"],
      rows: rows.map((row) => [row.id, row.parent_id, row.directory, row.metadata]),
    },
  ]
  const current = { sql, json }
  const found = collect(current)
  const expected = yield* project({
    source,
    target: current,
    mapping: new Map(Object.entries(review.workspaces)),
    stage: data,
    destination: data,
  }).pipe(Effect.provide(LayerNode.compile(FSUtil.node)))
  if (!isDeepStrictEqual(expected.json, json) || !isDeepStrictEqual(expected.sql, sql))
    throw new Error("Restored Task file scopes differ from retained source and mapping")
  return found.filter((entry) => entry.relation === "bound").map((entry) => entry.binding)
})

function missing(err: unknown) {
  return err instanceof Error && "code" in err && err.code === "ENOENT"
}
async function optional(file: string, budget: number) {
  return read(file, budget, budget).catch((err: unknown) => {
    if (missing(err)) return undefined
    throw err
  })
}
