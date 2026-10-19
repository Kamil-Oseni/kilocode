import { open, realpath, type FileHandle } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Final } from "../shared/routine-output"

async function read(file: FileHandle) {
  const before = await file.stat()
  if (!before.isFile() || before.size > 8192) throw new Error("Choose a UTF-8 file no larger than 8192 bytes.")
  const data = Buffer.alloc(8193)
  let size = 0
  while (size < data.length) {
    const next = await file.read(data, size, data.length - size, size)
    if (!next.bytesRead) break
    size += next.bytesRead
  }
  const after = await file.stat()
  if (
    size > 8192 ||
    before.size !== size ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("The file changed while it was read. Choose it again.")
  const bytes = data.subarray(0, size)
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  return { bytes, stat: after }
}

export async function pin(path: string) {
  const canonical = await realpath(path)
  const file = await open(canonical, "r")
  try {
    const first = await read(file)
    if ((await realpath(path)) !== canonical) throw new Error("The selected file target changed. Choose it again.")
    const target = await open(canonical, "r")
    try {
      const next = await read(target)
      if (first.stat.dev !== next.stat.dev || first.stat.ino !== next.stat.ino || !first.bytes.equals(next.bytes))
        throw new Error("The selected file changed. Choose it again.")
      if ((await realpath(path)) !== canonical || (await realpath(canonical)) !== canonical)
        throw new Error("The selected file target changed. Choose it again.")
      return Final.parse({
        kind: "file",
        path: canonical,
        bytes: first.bytes.length,
        sha256: createHash("sha256").update(first.bytes).digest("hex"),
      })
    } finally {
      await target.close()
    }
  } finally {
    await file.close()
  }
}

export async function choose(opts: {
  requestID: unknown
  current: () => boolean
  pick: () => Promise<string | undefined>
  post: (message: unknown) => void
}) {
  if (typeof opts.requestID !== "string" || !opts.requestID || opts.requestID.length > 128 || !opts.current()) return
  const requestID = opts.requestID
  try {
    const path = await opts.pick()
    if (!opts.current()) return
    const final = path ? await pin(path) : undefined
    if (opts.current()) opts.post({ type: "routineFinalPicked", requestID, final, cancelled: !path })
  } catch (err) {
    if (opts.current())
      opts.post({
        type: "routineFinalPicked",
        requestID,
        error: err instanceof Error ? err.message : "The file could not be read. Choose it again.",
      })
  }
}
