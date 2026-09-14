export interface OfficeImage {
  readonly mime: "image/png" | "image/jpeg"
  readonly extension: "png" | "jpg"
  readonly width: number
  readonly height: number
}

function valid(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error("The image dimensions are invalid.")
  if (width > 10_000 || height > 10_000 || width * height > 50_000_000)
    throw new Error("The image exceeds the 10,000-pixel or 50-megapixel dimension limit.")
  return { width, height }
}

export function parseImage(bytes: Uint8Array, extension: string): OfficeImage {
  const ext = extension.toLowerCase()
  if (ext === ".png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value))
      throw new Error("The .png file does not contain a valid PNG signature and header.")
    if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error("The PNG is missing its IHDR header.")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const size = valid(view.getUint32(16), view.getUint32(20))
    return { mime: "image/png", extension: "png", ...size }
  }
  if (ext !== ".jpg" && ext !== ".jpeg") throw new Error("Document images must end in .png, .jpg or .jpeg.")
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("The JPEG file does not contain a valid JPEG signature.")
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
      if (length < 7) throw new Error("The JPEG frame header is incomplete.")
      const size = valid((bytes[offset + 5]! << 8) | bytes[offset + 6]!, (bytes[offset + 3]! << 8) | bytes[offset + 4]!)
      return { mime: "image/jpeg", extension: "jpg", ...size }
    }
    offset += length
  }
  throw new Error("The JPEG is missing a supported frame header.")
}
