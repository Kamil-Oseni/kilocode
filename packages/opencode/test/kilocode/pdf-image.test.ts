import { inflateSync } from "node:zlib"
import { describe, expect, test } from "bun:test"
import { parsePdfImage } from "@/kilocode/tool/pdf-image"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY3ANrWoAAAOMAZVXSuBOAAAAAElFTkSuQmCC",
  "base64",
)
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwqiiivuDwj//Z",
  "base64",
)

describe("PDF images", () => {
  test("converts a transparent PNG into bounded color and soft-mask streams", () => {
    const image = parsePdfImage(png, ".png")
    expect(image).toMatchObject({ width: 1, height: 1, color: "DeviceRGB", filter: "FlateDecode" })
    expect(inflateSync(Buffer.from(image.bytes))).toEqual(Buffer.from([69, 85, 122]))
    expect(inflateSync(Buffer.from(image.alpha!))).toEqual(Buffer.from([128]))
  })

  test("preserves a valid RGB JPEG stream for native PDF decoding", () => {
    const image = parsePdfImage(jpeg, ".jpeg")
    expect(image).toMatchObject({ width: 1, height: 1, color: "DeviceRGB", filter: "DCTDecode" })
    expect(image.bytes).toEqual(jpeg)
    expect(image.alpha).toBeUndefined()
  })

  test("refuses malformed compressed PNG data", () => {
    const corrupt = png.slice()
    const marker = corrupt.indexOf(Buffer.from("IDAT"))
    corrupt[marker + 5] ^= 0xff
    expect(() => parsePdfImage(corrupt, ".png")).toThrow()
  })
})
