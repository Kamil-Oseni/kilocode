import { createHash } from "node:crypto"
import { open } from "node:fs/promises"

export interface Identity {
  readonly dev: string
  readonly ino: string
}

function stale(path: string, message = "File target or content changed after approval.") {
  return Object.assign(new Error(message), {
    code: "ESTALE",
    path,
    syscall: "writeFileChecked",
  })
}

export async function writeChecked(path: string, data: Uint8Array, identity: Identity, sha256: string) {
  const file = await open(path, "r+")
  try {
    const info = await file.stat({ bigint: true })
    if (info.dev.toString() !== identity.dev || info.ino.toString() !== identity.ino) throw stale(path)
    if (info.nlink !== 1n) {
      throw stale(path, "Hard-linked files cannot be changed by an agent. Replace it with an independent copy first.")
    }
    const current = await file.readFile()
    if (createHash("sha256").update(current).digest("hex") !== sha256) throw stale(path)
    await file.truncate(0)
    for (let offset = 0; offset < data.byteLength; ) {
      const result = await file.write(data, offset, data.byteLength - offset, offset)
      if (result.bytesWritten === 0)
        throw Object.assign(new Error("Unable to finish checked file write."), { code: "EIO", path })
      offset += result.bytesWritten
    }
    await file.sync()
  } finally {
    await file.close()
  }
}
