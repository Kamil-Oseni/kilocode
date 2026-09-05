/**
 * Convert a dropped file URI or absolute path into a relative workspace path.
 * Strips file:// and vscode-remote:// protocols, decodes URI components,
 * and produces a relative path (e.g. "src/index.ts") when the file is inside
 * the workspace. Returns the cleaned absolute path for files outside the workspace.
 *
 * The returned path does NOT include the "@" prefix — callers add that when
 * inserting into the textarea so the path can also be registered in mentionedPaths.
 */
export function convertToMentionPath(path: string, cwd: string): string {
  let cleaned = path

  if (cleaned.startsWith("file://")) {
    cleaned = cleaned.substring(7)
  } else if (cleaned.startsWith("vscode-remote://")) {
    const rest = cleaned.substring("vscode-remote://".length)
    const idx = rest.indexOf("/")
    cleaned = idx !== -1 ? rest.substring(idx) : ""
  }

  try {
    cleaned = decodeURIComponent(cleaned)
    // Remove leading slash for Windows paths like /d:/...
    if (cleaned.startsWith("/") && cleaned[2] === ":") {
      cleaned = cleaned.substring(1)
    }
  } catch (err) {
    console.error("[Kilo New] Failed to decode dropped URI:", err, cleaned)
  }

  const normalized = cleaned.replace(/\\/g, "/")
  let root = cwd.replace(/\\/g, "/")
  if (root.endsWith("/")) root = root.slice(0, -1)

  if (!root) return cleaned

  if (normalized.toLowerCase().startsWith(root.toLowerCase())) {
    const tail = normalized.substring(root.length)
    // Boundary check: next char must be "/" or end of string to avoid
    // /workspace/app matching /workspace/app2/file.ts
    if (tail === "" || tail.startsWith("/")) {
      const relative = tail.startsWith("/") ? tail.substring(1) : tail
      return relative || cleaned
    }
  }

  return cleaned
}

export const KILO_FILE_PATH_MIME = "application/x-kilo-file-path"

function isFilePath(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (text.startsWith("{") && text.includes("resourceurls")) return false
  if (text.startsWith("file://") || text.startsWith("vscode-remote://")) return true
  if (text.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  return false
}

function decodeDrop(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as unknown
      const urls =
        json && typeof json === "object" && "resourceurls" in json
          ? (json as { resourceurls?: unknown }).resourceurls
          : json
      if (Array.isArray(urls)) {
        return urls.flatMap((item) => {
          if (typeof item === "string") return decodeDrop(item)
          if (item && typeof item === "object" && "fsPath" in item && typeof item.fsPath === "string") return [item.fsPath]
          return []
        })
      }
    } catch (err) {
      console.error("[Kilo New] Failed to parse drop payload:", err)
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

export function extractDropPaths(dt: DataTransfer): string[] | null {
  const kilo = dt.getData(KILO_FILE_PATH_MIME)
  if (kilo) {
    const paths = kilo.split(/\r?\n/).filter((line) => line.trim() !== "")
    if (paths.length > 0) return paths
  }

  for (const type of ["application/vnd.code.resourceurls", "codefiles", "application/vnd.code.uri-list"]) {
    const raw = dt.getData(type)
    if (!raw) continue
    const paths = decodeDrop(raw)
    if (paths.length > 0) return paths
  }

  const files = dt.files
  if (files && files.length > 0) {
    const paths = Array.from(files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((item): item is string => typeof item === "string" && item.length > 0)
    if (paths.length > 0) return paths
  }

  const text = dt.getData("text")
  if (text) {
    const lines = decodeDrop(text)
    if (lines.length > 0 && lines.every(isFilePath)) return lines
  }

  return null
}
