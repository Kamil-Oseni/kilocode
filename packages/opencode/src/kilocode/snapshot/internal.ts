import path from "node:path"

/** Exclude runtime stores only when they are descendants of the worktree. */
export function internal(root: string, stores: readonly string[]) {
  // Coordination names are reserved exclusions, not proof of profile ownership.
  const paths = [
    ...new Set([...stores, path.join(root, ".raya-profile-locks")].map((store) => path.relative(root, store))),
  ].filter((item) => item && item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item))
  const contains = (file: string) => {
    const relative = path.relative(root, path.resolve(root, file))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
    if (
      relative
        .split(path.sep)
        .some((item) => (process.platform === "win32" ? item.toLowerCase() : item) === ".raya-profile-locks")
    )
      return true
    return paths.some((item) => {
      const relative = path.relative(path.resolve(root, item), path.resolve(root, file))
      return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    })
  }
  const patterns = paths.map(
    (item) =>
      `/${item
        .split(path.sep)
        .join("/")
        .replace(/[\\*?\[\] !#]/g, "\\$&")}/`,
  )
  return { paths, patterns: [...patterns, "**/.raya-profile-locks/"], contains }
}
