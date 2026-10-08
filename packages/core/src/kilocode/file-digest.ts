import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { open, stat } from "node:fs/promises"

const same = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.nlink === right.nlink

/** Hash one retained regular file without allocating its entire image. */
export async function digest(file: string) {
  const before = await stat(file, { bigint: true })
  if (!before.isFile()) throw new Error("Digest requires a regular file")
  const handle = await open(file, "r")
  try {
    const initial = await handle.stat({ bigint: true })
    if (!same(before, initial)) throw new Error("Digest file changed before reading")
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(1048576)
    let size = 0n
    while (size < initial.size) {
      const remaining = initial.size - size
      const limit = remaining < BigInt(buffer.length) ? Number(remaining) : buffer.length
      const result = await handle.read(buffer, 0, limit, null)
      if (!result.bytesRead) throw new Error("Digest file was truncated during reading")
      hash.update(buffer.subarray(0, result.bytesRead))
      size += BigInt(result.bytesRead)
    }
    const tail = await handle.read(buffer, 0, 1, null)
    if (
      tail.bytesRead ||
      !same(initial, await handle.stat({ bigint: true })) ||
      !same(initial, await stat(file, { bigint: true }))
    )
      throw new Error("Digest file changed during reading")
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}
