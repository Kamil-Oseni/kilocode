import { Readable } from "node:stream"
import path from "node:path"
import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js"

const MAX_SIZE = 64 * 1024 * 1024
const MAX_TEXT = 8 * 1024 * 1024
const MAX_SLIDES = 500

export function accepts(filepath: string) {
  return path.extname(filepath).toLowerCase() === ".pptx"
}

export function limit() {
  return MAX_SIZE
}

function decode(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}

export async function open(filepath: string, bytes: Buffer) {
  if (bytes.length > MAX_SIZE)
    throw new Error(`Cannot read presentation file: ${filepath} exceeds the 64 MiB size limit`)
  // zip.js reads the whole backing buffer; copy Node's pooled Buffer view so unrelated bytes cannot look like split ZIP data.
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)))
  return reader
    .getEntries()
    .then(async (entries) => {
      const slides = entries
        .flatMap((entry) => {
          const match = /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/.exec(entry.filename)
          return match && entry.getData ? [{ entry, index: Number(match[1]) }] : []
        })
        .sort((a, b) => a.index - b.index)
      if (!slides.length) throw new Error(`Cannot read presentation file: ${filepath} has no slides`)
      if (slides.length > MAX_SLIDES)
        throw new Error(`Cannot read presentation file: ${filepath} exceeds the ${MAX_SLIDES}-slide limit`)
      let size = 0
      const output: string[] = []
      for (const slide of slides) {
        size += slide.entry.uncompressedSize
        if (size > MAX_TEXT)
          throw new Error(`Cannot read presentation file: ${filepath} exceeds the 8 MiB extracted-text limit`)
        const xml = await slide.entry.getData!(new TextWriter())
        const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decode(match[1]!))
        output.push(`--- Slide: ${slide.index} ---\n${text.join("\n")}`)
      }
      return Readable.from([output.join("\n\n")])
    })
    .finally(() => reader.close())
}
