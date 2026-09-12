import path from "node:path"

export const MAX_ROUTINE_FILE_BYTES = 5 * 1024 * 1024
export const MAX_ROUTINE_FILES = 8
export const MAX_ROUTINE_FILES_BYTES = 20 * 1024 * 1024

export type RoutineUpload = {
  id: string
  name: string
  mime: string
  size: number
  data: string
}

const mimes: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
}

function name(value: string) {
  const result = path.basename(value).trim()
  if (!result || result.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(result))
    throw new Error("Attachments need a plain file name no longer than 256 characters.")
  return result
}

export function encode(filename: string, bytes: Uint8Array): RoutineUpload {
  const size = bytes.byteLength
  if (size < 1) throw new Error(`${name(filename)} is empty and cannot be attached.`)
  if (size > MAX_ROUTINE_FILE_BYTES)
    throw new Error(`${name(filename)} is too large to attach. Choose a file no larger than 5 MB.`)
  const file = name(filename)
  return {
    id: crypto.randomUUID(),
    name: file,
    mime: mimes[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    size,
    data: Buffer.from(bytes).toString("base64"),
  }
}

export function bundle(files: RoutineUpload[], existing = 0) {
  if (existing < 0 || existing > MAX_ROUTINE_FILES || files.length + existing > MAX_ROUTINE_FILES)
    throw new Error(`Attach up to ${MAX_ROUTINE_FILES} files.`)
  if (files.reduce((size, file) => size + file.size, 0) > MAX_ROUTINE_FILES_BYTES)
    throw new Error("Routine attachments are limited to 20 MB in one message.")
  return files
}
