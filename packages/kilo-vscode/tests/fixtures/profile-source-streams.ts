import { createHash } from "node:crypto"
import type { Readable } from "node:stream"

/** Drain the original stream completely while retaining only a bounded diagnostic tail. */
export async function drain(stream: Readable | null) {
  const hash = createHash("sha256")
  let bytes = 0
  let tail = Buffer.alloc(0)
  if (!stream) return { bytes, sha256: hash.digest("hex"), EOF: false, joined: true, tail: "", error: "MissingStream" }
  try {
    for await (const part of stream) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
      bytes += chunk.length
      hash.update(chunk)
      tail = chunk.length >= 65536 ? Buffer.from(chunk.subarray(-65536)) : Buffer.concat([tail, chunk]).subarray(-65536)
    }
    return { bytes, sha256: hash.digest("hex"), EOF: true, joined: true, tail: tail.toString("utf8") }
  } catch (err) {
    return {
      bytes,
      sha256: hash.digest("hex"),
      EOF: false,
      joined: true,
      tail: tail.toString("utf8"),
      error: err instanceof Error ? err.name : "unknown",
    }
  }
}
