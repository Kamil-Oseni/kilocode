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
  } else if (cleaned.startsWith("vscode-file://")) {
    const rest = cleaned.substring("vscode-file://".length)
    const idx = rest.indexOf("/")
    cleaned = idx !== -1 ? rest.substring(idx) : rest
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

const DROP_TYPES = [
  KILO_FILE_PATH_MIME,
  "ResourceURLs",
  "application/vnd.code.resourceurls",
  "CodeFiles",
  "codefiles",
  "application/vnd.code.uri-list",
  "text/uri-list",
  "text/plain",
  "text",
]

function isFilePath(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (text.startsWith("{") && text.includes("resourceurls")) return false
  if (
    text.startsWith("file://") ||
    text.startsWith("vscode-remote://") ||
    text.startsWith("vscode-file://")
  )
    return true
  if (text.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  return false
}

function fromItem(item: unknown): string[] {
  if (typeof item === "string") return decodeDrop(item)
  if (!item || typeof item !== "object") return []
  const rec = item as { fsPath?: unknown; external?: unknown; path?: unknown; scheme?: unknown }
  if (typeof rec.fsPath === "string") return [rec.fsPath]
  if (typeof rec.external === "string") return decodeDrop(rec.external)
  if (typeof rec.path === "string" && rec.scheme === "file") return [rec.path]
  return []
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
      if (Array.isArray(urls)) return urls.flatMap(fromItem)
    } catch (err) {
      console.error("[Kilo New] Failed to parse drop payload:", err)
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.split("\t")[0]!.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

function read(dt: DataTransfer, type: string): string[] {
  const raw = dt.getData(type)
  return raw ? decodeDrop(raw) : []
}

export function extractDropPaths(dt: DataTransfer): string[] | null {
  const seen = new Set<string>()
  const types = [...DROP_TYPES]
  if (dt.types) types.push(...Array.from(dt.types))
  for (const type of types) {
    if (seen.has(type)) continue
    seen.add(type)
    const paths = read(dt, type)
    if (type === "text" || type === "text/plain") {
      if (paths.length > 0 && paths.every(isFilePath)) return paths
      continue
    }
    if (paths.length > 0) return paths
  }

  const files = dt.files
  if (files && files.length > 0) {
    const paths = Array.from(files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((item): item is string => typeof item === "string" && item.length > 0)
    if (paths.length > 0) return paths
  }

  return null
}
