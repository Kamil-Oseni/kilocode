import path from "node:path"

/** Exclude runtime stores only when they are descendants of the worktree. */
export function internal(root: string, stores: readonly string[]) {
  const paths = [...new Set(stores.map((store) => path.relative(root, store)))].filter(
    (item) => item && item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item),
  )
  const contains = (file: string) =>
    paths.some((item) => {
      const relative = path.relative(path.resolve(root, item), path.resolve(root, file))
      return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    })
  const patterns = paths.map(
    (item) =>
      `/${item
        .split(path.sep)
        .join("/")
        .replace(/[\\*?\[\] !#]/g, "\\$&")}/`,
  )
  return { paths, patterns, contains }
}
