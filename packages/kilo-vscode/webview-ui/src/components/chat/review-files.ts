export type Kind = "added" | "modified" | "deleted" | "renamed"
export type Target = { file: string; kind: Kind }

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function status(value: unknown): Kind {
  if (value === "delete" || value === "deleted") return "deleted"
  if (value === "move" || value === "renamed") return "renamed"
  if (value === "add" || value === "added") return "added"
  return "modified"
}

/** Paths the chat review chrome should offer Keep/Undo for. */
export function targets(tool: string, input: unknown, metadata: unknown): Target[] {
  const meta = record(metadata)
  const data = record(input)
  if (tool === "apply_patch" && Array.isArray(meta?.files)) {
    return meta.files.flatMap((item) => {
      const file = record(item)
      if (!file) return []
      const path = text(file.movePath) ?? text(file.relativePath) ?? text(file.filePath)
      if (!path) return []
      return [{ file: path, kind: status(file.type) }]
    })
  }
  if (tool === "multiedit" && Array.isArray(meta?.results)) {
    return meta.results.flatMap((item) => {
      const result = record(item)
      const diff = record(result?.filediff)
      const path = text(diff?.file)
      if (!path) return []
      return [{ file: path, kind: status(diff?.status) }]
    })
  }
  const diff = record(meta?.filediff)
  const path = text(diff?.file) ?? text(meta?.filepath) ?? text(data?.filePath)
  if (!path) return []
  return [{ file: path, kind: status(diff?.status) }]
}

export function note(kind: Kind) {
  if (kind === "deleted") return "Deleted file"
  if (kind === "renamed") return "Renamed file"
}
