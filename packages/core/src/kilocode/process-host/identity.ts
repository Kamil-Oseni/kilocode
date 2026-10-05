import { createHash } from "node:crypto"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"

const bound = 16 * 1024 * 1024
async function snapshot(file: FileHandle) {
  const info = await file.stat({ bigint: true })
  if (!info.isFile() || info.size <= 0n || info.size > BigInt(bound) || info.nlink !== 1n)
    throw new Error("Native process host executable invalid")
  const digest = createHash("sha256")
  const bytes = Buffer.alloc(64 * 1024)
  for (let offset = 0; offset < Number(info.size); ) {
    const read = await file.read(bytes, 0, Math.min(bytes.length, Number(info.size) - offset), offset)
    if (!read.bytesRead) throw new Error("Native process host changed during admission")
    digest.update(bytes.subarray(0, read.bytesRead))
    offset += read.bytesRead
  }
  const end = await file.stat({ bigint: true })
  if (info.dev !== end.dev || info.ino !== end.ino || info.size !== end.size || info.nlink !== end.nlink)
    throw new Error("Native process host changed during admission")
  return [info.dev, info.ino, info.size, digest.digest("hex")].join(":")
}

/** ctime is metadata, not executable identity. Hold and rehash bytes/object around protocol, without retry. */
export async function admission<A>(path: string, body: (identity: string) => Promise<A>): Promise<A> {
  if ((await lstat(path)).isSymbolicLink()) throw new Error("Native process host executable invalid")
  const physical = await realpath(path)
  const file = await open(path, "r")
  try {
    const before = await snapshot(file)
    const result = await body(path + ":" + physical + ":" + before)
    if (
      (await snapshot(file)) !== before ||
      (await realpath(path)) !== physical ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new Error("Native process host changed during admission")
    const current = await open(path, "r")
    try {
      if ((await snapshot(current)) !== before) throw new Error("Native process host changed during admission")
    } finally {
      await current.close()
    }
    return result
  } finally {
    await file.close()
  }
}
