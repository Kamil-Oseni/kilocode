import { lstat, open, realpath } from "node:fs/promises"

/** A directory gate does not exclude a writer using an outside hardlink alias. */
export async function regular(file: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("Profile capture file is not a unique regular file")
  return realpath(file)
}

export async function database(file: string) {
  const resolved = await regular(file)
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = resolved + suffix
    const info = await lstat(sidecar).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (info) await regular(sidecar)
  }
  return resolved
}

/** Bound allocation even if an unverified writer changes a file during admission. */
export async function read(file: string, budget: number, maximum = 16_777_216) {
  if (!Number.isSafeInteger(budget) || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 128 * 1024 * 1024)
    throw new Error("Invalid portable file size bound")
  const resolved = await regular(file)
  const handle = await open(resolved, "r")
  try {
    const info = await handle.stat()
    const limit = Math.min(maximum, budget)
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || limit < 0)
      throw new Error("Portable JSON exceeds its supported size")
    const buffer = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset !== info.size) throw new Error("Portable JSON changed during capture")
    return { value: buffer.subarray(0, offset).toString("utf8"), bytes: offset }
  } finally {
    await handle.close()
  }
}
