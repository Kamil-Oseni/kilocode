import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import z from "zod"

const file = z
  .string()
  .min(1)
  .max(4096)
  .refine((file) => path.isAbsolute(file) && path.normalize(file) === file)
const identity = { volume: z.number().int().nonnegative(), index: z.string().regex(/^\d+$/) }
const child = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !/[\\/:\0\r\n]/.test(name) && name !== "." && name !== ".."),
    directory: z.boolean(),
    ...identity,
  })
  .strict()
export const directoryInventory = z
  .array(
    z
      .object({
        original: file,
        staged: file,
        ...identity,
        children: z.array(child).max(16384),
      })
      .strict(),
  )
  .max(16384)
  .superRefine((value, ctx) => {
    if (value.reduce((sum, item) => sum + item.children.length, 0) > 16384)
      ctx.addIssue({ code: "custom", message: "Directory child inventory exceeded bound" })
    if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Directory metadata exceeded bound" })
  })
type Root = Readonly<{ kind: "json" | "sqlite" | "negative"; original: string; staged: string; directory: boolean }>
type File = Readonly<{ original: string; staged: string; volume: number; index: string }>
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const inside = (root: string, file: string) => {
  const relative = path.relative(key(root), key(file))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

/** Validate only the already held private image. Source directory contents are never enumerated here. */
export async function validateDirectoryInventory(roots: readonly Root[], files: readonly File[], input: unknown) {
  const value = directoryInventory.parse(input)
  const records = new Map(value.map((item) => [key(item.staged), item]))
  const images = new Map(files.map((item) => [key(item.staged), item]))
  if (records.size !== value.length || images.size !== files.length)
    throw new Error("Native image inventory contains duplicate staged paths")
  for (const root of roots) {
    if (root.kind !== "json" || !root.directory) continue
    const directory = records.get(key(root.staged))
    if (!directory || key(directory.original) !== key(root.original))
      throw new Error("Declared directory root lacks native traversal evidence")
  }
  for (const item of value) {
    const root = roots.find(
      (root) =>
        root.kind === "json" &&
        root.directory &&
        inside(root.original, item.original) &&
        key(path.join(root.staged, path.relative(root.original, item.original))) === key(item.staged),
    )
    if (!root) throw new Error("Directory inventory escapes positive mapped roots")
    const names = new Set(item.children.map((child) => key(child.name)))
    if (names.size !== item.children.length) throw new Error("Directory inventory contains duplicate child names")
    const actual = await lstat(item.staged)
    if (!actual.isDirectory() || actual.isSymbolicLink()) throw new Error("Held directory image changed")
    const entries = await readdir(item.staged, { withFileTypes: true })
    if (entries.length !== item.children.length || entries.some((entry) => !names.has(key(entry.name))))
      throw new Error("Held directory child set differs from native traversal")
    for (const child of item.children) {
      const staged = path.join(item.staged, child.name)
      const original = path.join(item.original, child.name)
      const target = child.directory ? records.get(key(staged)) : images.get(key(staged))
      if (
        !target ||
        target.volume !== child.volume ||
        target.index !== child.index ||
        key(target.original) !== key(original)
      )
        throw new Error("Directory child lacks its exact native object linkage")
      const info = await lstat(staged)
      if (info.isSymbolicLink() || (child.directory ? !info.isDirectory() : !info.isFile()))
        throw new Error("Held directory child kind differs")
    }
  }
  for (const item of [...value, ...files]) {
    const root = roots.find(
      (root) =>
        root.kind === "json" &&
        root.directory &&
        inside(root.original, item.original) &&
        key(path.join(root.staged, path.relative(root.original, item.original))) === key(item.staged),
    )
    if (!root || key(root.staged) === key(item.staged)) continue
    const parent = records.get(key(path.dirname(item.staged)))
    if (!parent?.children.some((child) => key(child.name) === key(path.basename(item.staged))))
      throw new Error("Native descendant lacks a recorded parent edge")
  }
  return Object.freeze(
    value.map((item) =>
      Object.freeze({ ...item, children: Object.freeze(item.children.map((child) => Object.freeze(child))) }),
    ),
  )
}
