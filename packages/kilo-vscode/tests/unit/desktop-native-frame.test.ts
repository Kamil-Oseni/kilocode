import { describe, expect, it } from "bun:test"
import { NativeFrameParser } from "../../src/services/computer-use/desktop-native-frame"

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const target = {
  v: 1,
  type: "frame",
  sequence: 1,
  windowID: "0x12AB",
  location: "pid:42;title:Editor;bounds:10,20,100,80",
  width: 100,
  height: 80,
  mime: "image/png",
  acquisitionMs: 4,
  preparationMs: 3,
}

function encode(header: Record<string, unknown>, image = png) {
  const json = Buffer.from(JSON.stringify(header), "utf8")
  const packet = Buffer.allocUnsafe(8 + json.length + image.length)
  packet.writeUInt32LE(json.length, 0)
  json.copy(packet, 4)
  packet.writeUInt32LE(image.length, 4 + json.length)
  image.copy(packet, 8 + json.length)
  return packet
}

describe("bounded native desktop frame protocol", () => {
  it("reads split and coalesced binary frames with a monotonic sequence", () => {
    const parser = new NativeFrameParser()
    const first = encode(target)
    expect(parser.push(first.subarray(0, 2))).toEqual([])
    expect(parser.push(first.subarray(2, 7))).toEqual([])
    const result = parser.push(Buffer.concat([first.subarray(7), encode({ ...target, sequence: 2 })]))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "frame", frame: { sequence: 1, windowID: "0x12AB", width: 100 } })
    expect(result[1]).toMatchObject({ type: "frame", frame: { sequence: 2 } })
    expect(result[0]?.type === "frame" && result[0].frame.data.equals(png)).toBe(true)
    parser.finish()
  })

  it("accepts explicit zero-pixel failure packets and refuses image-bearing errors", () => {
    const parser = new NativeFrameParser()
    expect(parser.push(encode({ v: 1, type: "error", code: "device_lost" }, Buffer.alloc(0)))).toEqual([
      { type: "error", code: "device_lost" },
    ])
    expect(() => parser.push(encode(target))).toThrow(/already failed/i)
    expect(() => new NativeFrameParser().push(encode({ v: 1, type: "error", code: "device_lost" }))).toThrow(
      /error packet/i,
    )
    expect(() =>
      new NativeFrameParser().push(
        Buffer.concat([encode({ v: 1, type: "error", code: "device_lost" }, Buffer.alloc(0)), encode(target)]),
      ),
    ).toThrow(/unexpected data/i)
  })

  it("refuses oversized headers and encoded frames before buffering payloads", () => {
    const parser = new NativeFrameParser()
    const header = Buffer.alloc(4)
    header.writeUInt32LE(4_097)
    expect(() => parser.push(header)).toThrow(/header exceeds/i)
    expect(() => parser.push(encode(target))).toThrow(/already failed/i)

    const next = new NativeFrameParser()
    const data = encode(target).subarray(0, 8 + JSON.stringify(target).length)
    data.writeUInt32LE(15_000_001, data.length - 4)
    expect(() => next.push(data)).toThrow(/image exceeds/i)
  })

  it("refuses partial streams, replayed sequences and malformed target or image metadata", () => {
    const parser = new NativeFrameParser()
    parser.push(encode(target).subarray(0, 20))
    expect(() => parser.finish()).toThrow(/partial packet/i)

    const replay = new NativeFrameParser()
    replay.push(encode(target))
    expect(() => replay.push(encode(target))).toThrow(/sequence replayed/i)
    expect(() => new NativeFrameParser().push(encode({ ...target, windowID: "0xZZ" }))).toThrow(/window identity/i)
    expect(() => new NativeFrameParser().push(encode({ ...target, width: 5000 }))).toThrow(/width is invalid/i)
    expect(() => new NativeFrameParser().push(encode({ ...target, mime: "image/jpeg" }))).toThrow(/JPEG signature/i)
    const invalid = encode(target)
    invalid[4] = 0xff
    expect(() => new NativeFrameParser().push(invalid)).toThrow()
  })
})
