export function present(files: readonly string[], untracked: ReadonlySet<string>, existing: ReadonlySet<string>) {
  return files.filter((file) => !untracked.has(file) || existing.has(file))
}
