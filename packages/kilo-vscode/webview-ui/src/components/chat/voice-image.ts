const LIMIT = 256 * 1024

/** Decode only supported raster sources and emit a small JPEG for deliberate voice sharing. */
export async function prepare(file: File) {
  if (!file.size || file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP image no larger than 8 MiB.")
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp =
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  if (!png && !jpeg && !webp) throw new Error("This file is not a supported raster image.")
  const bitmap = await createImageBitmap(file)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000)
      throw new Error("Choose an image with at most 40 megapixels.")
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Image preparation is unavailable in this window.")
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)) * 0.75 ** attempt
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82))
      if (!blob || blob.size > LIMIT) continue
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () =>
          typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Image preparation failed."))
        reader.onerror = () => reject(new Error("Image preparation failed."))
        reader.readAsDataURL(blob)
      })
      return { data, width: canvas.width, height: canvas.height }
    }
    throw new Error("This image could not be reduced to the voice-sharing limit.")
  } finally {
    bitmap.close()
  }
}
