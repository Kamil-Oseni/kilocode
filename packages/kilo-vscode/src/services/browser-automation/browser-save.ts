import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { copyFile, lstat, open, realpath, rename, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

export function filename(value: string) {
  const name = value
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 200)
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `download_${name || "file"}` : name
}

export async function destination(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
}

export async function save(
  source: string,
  target: string,
  expected: { bytes: number; sha256: string },
  replace = false,
) {
  const original = await destination(target)
  if (original && (!replace || original.isSymbolicLink() || !original.isFile()))
    throw new Error("Destination exists; choose another file or explicitly confirm replacement of a regular file")
  if (resolve(source) === resolve(target))
    throw new Error("Choose a destination outside the original download artifact")
  const parent = await realpath(dirname(target))
  const file = join(parent, `.raya-download-${randomUUID()}.tmp`)
  const hash = createHash("sha256")
  let bytes = 0
  try {
    await pipeline(
      createReadStream(source),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          hash.update(chunk)
          callback(null, chunk)
        },
      }),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    )
    if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
      throw new Error("Download bytes changed; no copy was published")
    const handle = await open(file, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!original) {
      await copyFile(file, target, constants.COPYFILE_EXCL)
      const copied = await open(target, "r+")
      try {
        await copied.sync()
      } finally {
        await copied.close()
      }
      return
    }
    const current = await destination(target)
    if (
      !current ||
      current.isSymbolicLink() ||
      current.ino !== original.ino ||
      current.size !== original.size ||
      current.mtimeMs !== original.mtimeMs
    )
      throw new Error("Destination changed while copying; existing file was preserved")
    await rename(file, target)
  } finally {
    await unlink(file).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    })
  }
}
