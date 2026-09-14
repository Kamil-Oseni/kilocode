import { deflateSync, inflateSync } from "node:zlib"
import { parseImage } from "./office-image"

export type PdfImage = {
  readonly width: number
  readonly height: number
  readonly color: "DeviceGray" | "DeviceRGB"
  readonly bytes: Uint8Array
  readonly filter: "DCTDecode" | "FlateDecode"
  readonly alpha?: Uint8Array
}

function jpeg(bytes: Uint8Array, width: number, height: number): PdfImage {
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  for (let offset = 2; offset + 4 <= bytes.length; ) {
    if (bytes[offset] !== 0xff) throw new Error("The JPEG marker sequence is invalid.")
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.length) throw new Error("The JPEG segment length is invalid.")
    if (frames.has(marker)) {
      const channels = bytes[offset + 7]
      if (channels !== 1 && channels !== 3) throw new Error("PDF images support grayscale or RGB JPEG files.")
      return {
        width,
        height,
        color: channels === 1 ? "DeviceGray" : "DeviceRGB",
        bytes,
        filter: "DCTDecode",
      }
    }
    offset += length
  }
  throw new Error("The JPEG is missing a supported frame header.")
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function png(bytes: Uint8Array, width: number, height: number): PdfImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13) throw new Error("The PNG IHDR length is invalid.")
  const depth = bytes[24]
  const kind = bytes[25]
  if (depth !== 8) throw new Error("PDF PNG images must use 8-bit channels.")
  const channels = kind === 0 || kind === 3 ? 1 : kind === 2 ? 3 : kind === 4 ? 2 : kind === 6 ? 4 : 0
  if (!channels) throw new Error("The PNG color type is not supported for PDF output.")
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0)
    throw new Error("PDF PNG images must use standard compression, filtering and no interlacing.")

  const chunks: Uint8Array[] = []
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  let ended = false
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset)
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) throw new Error("The PNG chunk length is invalid.")
    const checksum = Bun.hash.crc32(bytes.subarray(offset + 4, end)) >>> 0
    if (checksum !== view.getUint32(end)) throw new Error("The PNG chunk checksum is invalid.")
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    const data = bytes.slice(start, end)
    if (type === "IDAT") chunks.push(data)
    if (type === "PLTE") palette = data
    if (type === "tRNS") transparency = data
    offset = end + 4
    if (type === "IEND") {
      ended = true
      break
    }
  }
  if (!ended || !chunks.length) throw new Error("The PNG is missing image data or its end marker.")
  if (kind === 3 && (!palette || !palette.length || palette.length % 3 || palette.length > 768))
    throw new Error("The indexed PNG palette is invalid.")

  const packed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    packed.set(chunk, offset)
    offset += chunk.length
  }
  const stride = width * channels
  const expected = (stride + 1) * height
  const inflated = inflateSync(packed, { maxOutputLength: expected })
  if (inflated.length !== expected) throw new Error("The PNG decompressed size does not match its dimensions.")

  const pixels = new Uint8Array(stride * height)
  for (let row = 0; row < height; row++) {
    const source = row * (stride + 1)
    const target = row * stride
    const filter = inflated[source]
    if (filter === undefined || filter > 4) throw new Error("The PNG uses an invalid row filter.")
    for (let column = 0; column < stride; column++) {
      const value = inflated[source + column + 1]!
      const left = column >= channels ? pixels[target + column - channels]! : 0
      const above = row ? pixels[target + column - stride]! : 0
      const upperLeft = row && column >= channels ? pixels[target + column - stride - channels]! : 0
      const delta =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft)
      pixels[target + column] = (value + delta) & 0xff
    }
  }

  const rgb = new Uint8Array(width * height * 3)
  const alpha = new Uint8Array(width * height)
  let transparent = false
  for (let index = 0; index < width * height; index++) {
    const source = index * channels
    const target = index * 3
    if (kind === 0 || kind === 4) {
      const value = pixels[source]!
      rgb[target] = value
      rgb[target + 1] = value
      rgb[target + 2] = value
      alpha[index] =
        kind === 4 ? pixels[source + 1]! : transparency?.length === 2 && viewValue(transparency) === value ? 0 : 255
    }
    if (kind === 2 || kind === 6) {
      rgb[target] = pixels[source]!
      rgb[target + 1] = pixels[source + 1]!
      rgb[target + 2] = pixels[source + 2]!
      const match =
        transparency?.length === 6 &&
        [0, 1, 2].every((part) => viewValue(transparency!, part * 2) === pixels[source + part])
      alpha[index] = kind === 6 ? pixels[source + 3]! : match ? 0 : 255
    }
    if (kind === 3) {
      const entry = pixels[source]!
      const item = entry * 3
      if (!palette || item + 2 >= palette.length) throw new Error("The PNG contains an invalid palette index.")
      rgb[target] = palette[item]!
      rgb[target + 1] = palette[item + 1]!
      rgb[target + 2] = palette[item + 2]!
      alpha[index] = transparency?.[entry] ?? 255
    }
    if (alpha[index] !== 255) transparent = true
  }
  return {
    width,
    height,
    color: "DeviceRGB",
    bytes: deflateSync(rgb),
    filter: "FlateDecode",
    alpha: transparent ? deflateSync(alpha) : undefined,
  }
}

function viewValue(bytes: Uint8Array, offset = 0) {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

export function parsePdfImage(bytes: Uint8Array, extension: string): PdfImage {
  const image = parseImage(bytes, extension)
  if (image.width * image.height > 12_000_000) throw new Error("PDF images are limited to 12 megapixels each.")
  if (image.mime === "image/jpeg") return jpeg(bytes, image.width, image.height)
  return png(bytes, image.width, image.height)
}
