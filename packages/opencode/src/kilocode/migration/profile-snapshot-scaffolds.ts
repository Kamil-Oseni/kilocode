import { lstat, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { inventory, type Working } from "./profile-image"

const name = z.string().regex(/^(?:covered\.references|[a-f0-9]{40}\.(?:owners|writers))$/)
const number = z
  .string()
  .max(20)
  .regex(/^\d+$/)
  .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
export const scaffold = z
  .object({
    source: z
      .string()
      .max(4096)
      .refine(
        (file) =>
          path.isAbsolute(file) &&
          !/[\0\r\n]/.test(file) &&
          path.basename(file).toLowerCase() === ".raya-profile-locks",
      ),
    dev: number,
    ino: number,
    children: z.array(z.object({ name, dev: number, ino: number }).strict()).max(64),
    activation: z.literal("inert"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.children.map((item) => item.name)).size !== value.children.length)
      ctx.addIssue({ code: "custom", message: "Duplicate Snapshot scaffold child" })
    if (value.children.some((item, index) => index > 0 && value.children[index - 1].name >= item.name))
      ctx.addIssue({ code: "custom", message: "Snapshot scaffold inventory is unordered" })
  })

/** This is a finite empty-directory policy, never ownership inferred from a filename. */
export async function inspect(source: string, file = source) {
  const check = async (file: string) => {
    const info = await lstat(file, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || key(await realpath(file)) !== key(file))
      throw new Error("Snapshot coordination scaffold is aliased or unsupported")
    return info
  }
  const before = await check(file)
  const entries = (await readdir(file)).sort()
  if (entries.length > 64) throw new Error("Snapshot coordination scaffold exceeds bound")
  const children = []
  for (const entry of entries) {
    name.parse(entry)
    const target = path.join(file, entry)
    const info = await check(target)
    if ((await readdir(target)).length) throw new Error("Snapshot coordination scaffold remains nonempty")
    const after = await check(target)
    if (after.dev !== info.dev || after.ino !== info.ino) throw new Error("Snapshot coordination scaffold changed")
    children.push({ name: entry, dev: String(info.dev), ino: String(info.ino) })
  }
  const after = await check(file)
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    JSON.stringify((await readdir(file)).sort()) !== JSON.stringify(entries)
  )
    throw new Error("Snapshot coordination scaffold changed")
  return scaffold.parse({ source, dev: String(before.dev), ino: String(before.ino), children, activation: "inert" })
}

/** Retain source identities only from the complete live native directory inventory. */
export async function bind(token: Working, source: string, staged: string) {
  const directories = inventory(token).directories
  if (!directories) throw new Error("Snapshot scaffold lacks native directory inventory")
  const read = await inspect(source, staged)
  const exact = (file: string) => {
    const matches = directories.filter((item) => key(item.path) === key(file))
    if (matches.length !== 1) throw new Error("Snapshot scaffold native directory is missing or ambiguous")
    return matches[0]
  }
  const root = exact(source)
  const parent = exact(path.dirname(source))
  const anchors = parent.children.filter((item) => item.name === path.basename(source))
  if (anchors.length !== 1 || !anchors[0].directory || anchors[0].dev !== root.dev || anchors[0].ino !== root.ino)
    throw new Error("Snapshot scaffold native parent binding differs")
  if (
    JSON.stringify(root.children.map((item) => item.name).sort()) !==
    JSON.stringify(read.children.map((item) => item.name))
  )
    throw new Error("Snapshot scaffold native children differ")
  const children = read.children.map((item) => {
    const child = exact(path.join(source, item.name))
    const anchor = root.children.filter((entry) => entry.name === item.name)
    if (
      anchor.length !== 1 ||
      !anchor[0].directory ||
      anchor[0].dev !== child.dev ||
      anchor[0].ino !== child.ino ||
      child.children.length
    )
      throw new Error("Snapshot scaffold native child is nonempty or changed")
    return { name: item.name, dev: child.dev, ino: child.ino }
  })
  return scaffold.parse({ source: root.path, dev: root.dev, ino: root.ino, children, activation: "inert" })
}
