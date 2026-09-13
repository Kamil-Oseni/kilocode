import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { openPromise } from "yauzl"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { z } from "zod"

const identity = z.object({ name: z.string(), publisher: z.string(), version: z.string() })
const metadata = z.object({
  PackageManifest: z.object({
    Metadata: z.object({
      Identity: z.object({
        "@_Id": z.string(),
        "@_Publisher": z.string(),
        "@_Version": z.string(),
        "@_TargetPlatform": z.string(),
      }),
    }),
  }),
})

type Bytes = { digest: string; size: number }
type Expected = {
  name: string
  publisher: string
  version: string
  target: string
  artifact?: Bytes
  binary?: Bytes
}

async function hash(stream: AsyncIterable<Uint8Array>, limit: number) {
  const value = createHash("sha256")
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > limit) throw new Error("Update content exceeds its size limit.")
    value.update(chunk)
  }
  return { digest: value.digest("hex"), size }
}

export async function checksum(path: string, expected: Bytes, limit = 1024 * 1024 * 1024) {
  const info = await stat(path)
  if (!info.isFile() || info.size !== expected.size || info.size > limit)
    throw new Error("Update file size does not match its approval.")
  const value = await hash(createReadStream(path), limit)
  if (value.digest !== expected.digest) throw new Error("Update file checksum does not match its approval.")
  return value
}

async function contents(zip: Awaited<ReturnType<typeof openPromise>>, target: string, verifyBinary: boolean) {
  const files = new Map<string, string>()
  const path = `extension/bin/${target.startsWith("win32-") ? "kilo.exe" : "kilo"}`
  let binary: Bytes | undefined
  let count = 0
  for await (const entry of zip.eachEntry()) {
    if (++count > 100_000) throw new Error("Update archive has too many entries.")
    if (entry.fileName.toLowerCase() === path.toLowerCase()) {
      if (!verifyBinary) continue
      if (entry.fileName !== path || binary) throw new Error("Update archive contains an ambiguous CLI binary.")
      if (entry.uncompressedSize > 512 * 1024 * 1024) throw new Error("Update CLI binary is too large.")
      const stream = await zip.openReadStreamPromise(entry)
      try {
        binary = await hash(stream, 512 * 1024 * 1024)
      } finally {
        stream.destroy()
      }
      continue
    }
    if (!["extension/package.json", "extension.vsixmanifest"].includes(entry.fileName)) continue
    if (files.has(entry.fileName)) throw new Error("Update archive contains duplicate manifests.")
    if (entry.uncompressedSize > 2 * 1024 * 1024) throw new Error("Update manifest is too large.")
    const stream = await zip.openReadStreamPromise(entry)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > 2 * 1024 * 1024) throw new Error("Update manifest exceeded its size limit.")
        chunks.push(bytes)
      }
    } finally {
      stream.destroy()
    }
    files.set(entry.fileName, Buffer.concat(chunks).toString("utf8"))
  }
  return { files, binary }
}

function manifests(files: Map<string, string>, expected: Expected) {
  const pkg = identity.parse(JSON.parse(files.get("extension/package.json") ?? "null"))
  const xml = files.get("extension.vsixmanifest") ?? ""
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("Invalid update XML manifest.")
  const manifest = metadata.parse(
    new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, processEntities: false }).parse(xml),
  )
  const id = manifest.PackageManifest.Metadata.Identity
  if (
    pkg.name !== expected.name ||
    pkg.publisher !== expected.publisher ||
    pkg.version !== expected.version ||
    id["@_Id"] !== expected.name ||
    id["@_Publisher"] !== expected.publisher ||
    id["@_Version"] !== expected.version ||
    id["@_TargetPlatform"] !== expected.target
  )
    throw new Error("Update package identity, version, or platform does not match this Raya release.")
}

/** Inspect bounded manifest entries without extracting executable archive content. */
export async function verify(path: string, expected: Expected) {
  if (expected.artifact) await checksum(path, expected.artifact)
  const zip = await openPromise(path, { strictFileNames: true, autoClose: false })
  try {
    const archive = await contents(zip, expected.target, !!expected.binary)
    manifests(archive.files, expected)
    if (
      expected.binary &&
      (!archive.binary ||
        archive.binary.digest !== expected.binary.digest ||
        archive.binary.size !== expected.binary.size)
    )
      throw new Error("Update CLI binary does not match its approval.")
  } finally {
    zip.close()
  }
  if (expected.artifact) await checksum(path, expected.artifact)
}
