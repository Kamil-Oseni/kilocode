import type { Artifacts } from "./profile-artifacts"

/** A reserved destination namespace is not evidence of a source owner's identity. */
export function controls(value: Pick<Artifacts, "repositories" | "worktrees" | "snapshots">) {
  const reserved = (file: string) =>
    file
      .replaceAll("\\", "/")
      .split("/")
      .some((part) => part.toLowerCase() === ".raya-profile-locks")
  return (
    value.repositories.some(
      (item) => item.files.some((file) => reserved(file.path)) || item.directories.some(reserved),
    ) ||
    value.snapshots.some((item) => reserved(item.project)) ||
    value.worktrees.some(
      (item) =>
        reserved(item.project) ||
        reserved(item.name) ||
        item.files.some((file) => reserved(file.path)) ||
        item.directories.some(reserved) ||
        item.admin.some((file) => reserved(file.path)) ||
        item.adminDirectories.some(reserved),
    )
  )
}
