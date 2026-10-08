import { createHash } from "node:crypto"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"

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

/** Synchronous native lifetimes hold and rehash the same helper object around the original query. */
export function synchronous<A>(path: string, body: (identity: string) => A): A {
  if (lstatSync(path).isSymbolicLink()) throw new Error("Native process host executable invalid")
  const physical = realpathSync(path)
  const file = openSync(path, "r")
  const snapshot = (fd: number) => {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.size <= 0n || info.size > BigInt(bound) || info.nlink !== 1n)
      throw new Error("Native process host executable invalid")
    const digest = createHash("sha256")
    const bytes = Buffer.alloc(64 * 1024)
    for (let offset = 0; offset < Number(info.size); ) {
      const size = readSync(fd, bytes, 0, Math.min(bytes.length, Number(info.size) - offset), offset)
      if (!size) throw new Error("Native process host changed during admission")
      digest.update(bytes.subarray(0, size))
      offset += size
    }
    const end = fstatSync(fd, { bigint: true })
    if (info.dev !== end.dev || info.ino !== end.ino || info.size !== end.size || info.nlink !== end.nlink)
      throw new Error("Native process host changed during admission")
    return [info.dev, info.ino, info.size, digest.digest("hex")].join(":")
  }
  try {
    const before = snapshot(file)
    const result = body(path + ":" + physical + ":" + before)
    if (snapshot(file) !== before || realpathSync(path) !== physical || lstatSync(path).isSymbolicLink())
      throw new Error("Native process host changed during admission")
    const current = openSync(path, "r")
    try {
      if (snapshot(current) !== before) throw new Error("Native process host changed during admission")
    } finally {
      closeSync(current)
    }
    return result
  } finally {
    closeSync(file)
  }
}
