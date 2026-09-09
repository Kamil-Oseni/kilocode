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

/** Inspect bounded manifest entries without extracting executable archive content. */
export async function verify(
  path: string,
  expected: { name: string; publisher: string; version: string; target: string },
) {
  const zip = await openPromise(path, { strictFileNames: true, autoClose: false })
  const files = new Map<string, string>()
  let count = 0
  try {
    for await (const entry of zip.eachEntry()) {
      if (++count > 100_000) throw new Error("Update archive has too many entries.")
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
  } finally {
    zip.close()
  }
}
