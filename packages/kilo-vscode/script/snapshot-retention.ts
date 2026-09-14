import { readdir, rm, stat } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"

const prefix = "eden.raya-"

function within(root: string, path: string) {
  const value = relative(root, path)
  return value !== "" && !value.startsWith("..") && !isAbsolute(value)
}

async function entries(root: string) {
  return readdir(root, { withFileTypes: true }).then(
    (value) => value,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return []
      throw err
    },
  )
}

export async function prune(input: {
  stage: string
  extensions: string
  version: string
  active?: readonly string[]
  retained?: number
}) {
  const stage = resolve(input.stage)
  const extensions = resolve(input.extensions)
  const files = (await entries(stage)).filter(
    (item) => item.isFile() && item.name.startsWith("raya-vscode-snapshot-") && item.name.endsWith(".vsix"),
  )
  await Promise.all(
    files.map(async (item) => {
      const path = resolve(stage, item.name)
      if (!within(stage, path)) throw new Error(`Refusing to remove snapshot outside ${stage}`)
      await rm(path, { force: true })
    }),
  )

  const dirs = (await entries(extensions)).filter(
    (item) => item.isDirectory() && item.name.startsWith(prefix) && item.name.includes("-snapshot+"),
  )
  const ranked = await Promise.all(
    dirs.map(async (item) => {
      const path = resolve(extensions, item.name)
      return { path, time: (await stat(path)).mtimeMs }
    }),
  ).then((value) => value.sort((a, b) => b.time - a.time))
  const keep = new Set(ranked.slice(0, input.retained ?? 2).map((item) => item.path.toLowerCase()))
  keep.add(resolve(extensions, `${prefix}${input.version}`).toLowerCase())
  for (const value of input.active ?? []) {
    const path = resolve(value)
    if (within(extensions, path) && basename(path).startsWith(prefix)) keep.add(path.toLowerCase())
  }
  const stale = ranked.filter((item) => !keep.has(item.path.toLowerCase()))
  await Promise.all(
    stale.map(async (item) => {
      if (!within(extensions, item.path)) throw new Error(`Refusing to remove extension outside ${extensions}`)
      await rm(item.path, { recursive: true, force: true })
    }),
  )
  return { packages: files.length, extensions: stale.length }
}
