import { describe, expect, test } from "bun:test"
import { parseImage } from "@/kilocode/tool/office-image"

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe("Office image admission", () => {
  test("reads bounded PNG and JPEG dimensions from their native headers", () => {
    expect(parseImage(png(640, 360), ".png")).toEqual({
      mime: "image/png",
      extension: "png",
      width: 640,
      height: 360,
    })
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03,
      0x11, 0x00, 0xff, 0xd9,
    ])
    expect(parseImage(jpeg, ".jpeg")).toEqual({
      mime: "image/jpeg",
      extension: "jpg",
      width: 3,
      height: 2,
    })
  })

  test("rejects extension, signature, frame and decompression-size mismatches", () => {
    expect(() => parseImage(png(1, 1), ".webp")).toThrow("must end")
    expect(() => parseImage(Uint8Array.from([1, 2, 3, 4]), ".png")).toThrow("valid PNG")
    expect(() => parseImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), ".jpg")).toThrow("frame header")
    expect(() => parseImage(png(10_001, 1), ".png")).toThrow("dimension limit")
    expect(() => parseImage(png(8_000, 8_000), ".png")).toThrow("dimension limit")
  })
})
