import { createHash } from "node:crypto"
import { BlobReader, ZipReader, type Entry } from "@zip.js/zip.js"
import { Parser } from "htmlparser2"
import { digest, identity, type Build } from "./build-input"

async function read(entry: Entry, limit: number, content = true) {
  if (entry.directory || entry.encrypted || !entry.getData || entry.uncompressedSize > limit)
    throw new Error("Artifact entry is unavailable or exceeds its size limit")
  const chunks: Uint8Array[] = []
  const hash = createHash("sha256")
  let size = 0
  await entry.getData(
    new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.length
        if (size > limit) throw new Error("Artifact entry exceeds its size limit")
        hash.update(chunk)
        if (content) chunks.push(chunk)
      },
    }),
    { checkSignature: true },
  )
  if (size !== entry.uncompressedSize) throw new Error("Artifact entry size mismatch")
  return { digest: hash.digest("hex"), size, text: content ? Buffer.concat(chunks).toString("utf8") : "" }
}

function manifest(text: string, input: Build) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Artifact XML contains unsupported declarations or entities")
  const stack: string[] = []
  const attrs = new Set<string>()
  let roots = 0
  let count = 0
  const parser = new Parser(
    {
      onopentagname() {
        attrs.clear()
      },
      onattribute(name, _value, quote) {
        if (!quote || attrs.has(name)) throw new Error("Artifact XML has ambiguous attributes")
        attrs.add(name)
      },
      onopentag(name, attributes) {
        if (!stack.length && (++roots !== 1 || name !== "PackageManifest")) throw new Error("Invalid VSIX XML root")
        stack.push(name)
        if (name !== "Identity") return
        if (
          stack.join("/") !== "PackageManifest/Metadata/Identity" ||
          ++count !== 1 ||
          attributes.Id !== "raya" ||
          attributes.Publisher !== "eden" ||
          attributes.Version !== input.extension ||
          attributes.TargetPlatform !== input.target
        )
          throw new Error("Artifact VSIX identity does not match its build input")
      },
      onclosetag(name, implied) {
        if (
          implied &&
          !text
            .slice(parser.startIndex, parser.endIndex + 1)
            .trimEnd()
            .endsWith("/>")
        )
          throw new Error("Artifact XML contains an implicit closing tag")
        if (stack.pop() !== name) throw new Error("Unbalanced artifact XML")
      },
      onprocessinginstruction(name) {
        if (name !== "?xml") throw new Error("Unsupported artifact XML instruction")
      },
      ontext(value) {
        if (!stack.length && value.trim()) throw new Error("Artifact XML contains content outside its root")
      },
      onerror(error) {
        throw error
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.end(text)
  if (stack.length || roots !== 1 || count !== 1) throw new Error("Artifact XML is missing its unique identity")
}

/** Inspect archive bytes independently of the build process's sidecar assertions. */
export async function inspect(input: Build) {
  const before = await digest(input.output)
  if (before.size > 1024 * 1024 * 1024) throw new Error("Artifact exceeds the 1 GiB inspection limit")
  const zip = new ZipReader(new BlobReader(Bun.file(input.output)), { useWebWorkers: false })
  const entries = new Map<string, Entry>()
  const binary = `extension/bin/${input.target.startsWith("win32-") ? "kilo.exe" : "kilo"}`
  const required = ["extension/package.json", "extension.vsixmanifest", "extension/dist/raya-build.json", binary]
  try {
    let count = 0
    for await (const entry of zip.getEntriesGenerator()) {
      if (++count > 100_000) throw new Error("Artifact has too many entries")
      const name = entry.filename
      if (name.includes("\\") || name.startsWith("/") || name.split("/").includes(".."))
        throw new Error("Artifact contains an unsafe archive path")
      if (!required.some((value) => value.toLowerCase() === name.toLowerCase())) continue
      if (!required.includes(name) || entries.has(name)) throw new Error("Artifact identity entries are ambiguous")
      entries.set(name, entry)
    }
    if (entries.size !== required.length) throw new Error("Artifact is missing required identity or CLI entries")
    const pkg = JSON.parse((await read(entries.get(required[0])!, 2 * 1024 * 1024)).text)
    if (pkg.name !== "raya" || pkg.publisher !== "eden" || pkg.version !== input.extension)
      throw new Error("Artifact package identity mismatch")
    manifest((await read(entries.get(required[1])!, 2 * 1024 * 1024)).text, input)
    const embedded = JSON.parse((await read(entries.get(required[2])!, 2 * 1024 * 1024)).text)
    const expected = identity(input)
    if (Object.entries(expected).some(([key, value]) => JSON.stringify(embedded[key]) !== JSON.stringify(value)))
      throw new Error("Artifact build identity does not match the retained build input")
    const cli = await read(entries.get(binary)!, 512 * 1024 * 1024, false)
    if (embedded.binary?.digest !== cli.digest || embedded.binary?.size !== cli.size)
      throw new Error("Packaged CLI bytes do not match the build evidence")
    const after = await digest(input.output)
    if (before.digest !== after.digest || before.size !== after.size)
      throw new Error("Artifact changed during inspection")
    return { artifact: after, binary: { digest: cli.digest, size: cli.size } }
  } finally {
    await zip.close()
  }
}
