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
const unchanged = {
  v: 1,
  type: "unchanged",
  sequence: 2,
  base: 1,
  windowID: target.windowID,
  location: target.location,
  width: target.width,
  height: target.height,
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
  const proof = {
    request: "a".repeat(32),
    scene: 7,
    source: 1,
    receiptQpc: "100",
    presentQpc: "101",
  }

  it("accepts a request-identified v2 frame only with a later native present", () => {
    const parser = new NativeFrameParser()
    const result = parser.push(Buffer.concat([encode(target), encode({ ...target, v: 2, sequence: 2, ...proof })]))
    expect(result[1]).toMatchObject({ type: "frame", frame: { sequence: 2, barrier: proof } })
    expect(() =>
      new NativeFrameParser().push(encode({ ...target, v: 2, sequence: 2, ...proof, presentQpc: "99" })),
    ).toThrow(/post-action present/i)
    expect(() => new NativeFrameParser().push(encode({ ...target, v: 2, sequence: 2, ...proof, source: 2 }))).toThrow(
      /post-action present/i,
    )
    expect(() =>
      new NativeFrameParser().push(encode({ ...target, v: 2, sequence: 2, ...proof, request: "wrong" })),
    ).toThrow(/barrier request/i)
    expect(() => new NativeFrameParser().push(encode({ ...target, sequence: 2, ...proof }))).toThrow(/unproven frame/i)
  })

  it("keeps an unproven v2 barrier separate from pixels and frame sequence", () => {
    const parser = new NativeFrameParser()
    const result = parser.push(
      Buffer.concat([
        encode(target),
        encode({ v: 2, type: "barrier", status: "unproven", reason: "no_present", ...proof }, Buffer.alloc(0)),
        encode({ ...target, sequence: 2 }),
      ]),
    )
    expect(result.map((item) => item.type)).toEqual(["frame", "barrier", "frame"])
    expect(() =>
      new NativeFrameParser().push(
        encode({
          v: 2,
          type: "barrier",
          status: "unproven",
          reason: "no_present",
          ...proof,
        }),
      ),
    ).toThrow(/barrier refusal/i)
    expect(() =>
      new NativeFrameParser().push(
        encode(
          {
            v: 2,
            type: "barrier",
            status: "proven",
            reason: "no_present",
            ...proof,
          },
          Buffer.alloc(0),
        ),
      ),
    ).toThrow(/barrier refusal/i)
  })

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

  it("accepts zero-image unchanged packets linked to the latest matching image", () => {
    const parser = new NativeFrameParser()
    const result = parser.push(
      Buffer.concat([
        encode(target),
        encode(unchanged, Buffer.alloc(0)),
        encode({ ...unchanged, sequence: 3 }, Buffer.alloc(0)),
        encode({ ...target, sequence: 4 }),
        encode({ ...unchanged, sequence: 5, base: 4 }, Buffer.alloc(0)),
      ]),
    )
    expect(result.map((item) => item.type)).toEqual(["frame", "unchanged", "unchanged", "frame", "unchanged"])
    expect(result[1]).toEqual({
      type: "unchanged",
      frame: {
        sequence: 2,
        base: 1,
        windowID: target.windowID,
        location: target.location,
        width: target.width,
        height: target.height,
      },
    })
    parser.finish()
  })

  it("refuses unchanged packets without a prior image or a matching base", () => {
    expect(() => new NativeFrameParser().push(encode(unchanged, Buffer.alloc(0)))).toThrow(/no matching base/i)
    const parser = new NativeFrameParser()
    parser.push(encode(target))
    expect(() => parser.push(encode({ ...unchanged, base: 0 }, Buffer.alloc(0)))).toThrow(/base is invalid/i)
    const stale = new NativeFrameParser()
    stale.push(encode(target))
    stale.push(encode({ ...target, sequence: 2 }))
    expect(() => stale.push(encode({ ...unchanged, sequence: 3 }, Buffer.alloc(0)))).toThrow(/matching base/i)
    expect(() => new NativeFrameParser().push(encode({ ...unchanged, base: 2 }, Buffer.alloc(0)))).toThrow(
      /base is invalid/i,
    )
  })

  it("refuses image-bearing, replayed, malformed or retargeted unchanged packets", () => {
    const image = new NativeFrameParser()
    image.push(encode(target))
    expect(() => image.push(encode(unchanged))).toThrow(/contains an image/i)

    const replay = new NativeFrameParser()
    replay.push(encode(target))
    replay.push(encode(unchanged, Buffer.alloc(0)))
    expect(() => replay.push(encode(unchanged, Buffer.alloc(0)))).toThrow(/sequence replayed/i)

    const retargeted = new NativeFrameParser()
    retargeted.push(encode(target))
    expect(() =>
      retargeted.push(encode({ ...unchanged, location: "pid:43;title:Editor;bounds:10,20,100,80" }, Buffer.alloc(0))),
    ).toThrow(/target differs/i)

    expect(() => new NativeFrameParser().push(encode({ ...unchanged, width: 5000 }, Buffer.alloc(0)))).toThrow(
      /width is invalid/i,
    )
    expect(() => new NativeFrameParser().push(encode({ ...unchanged, sequence: 1 }, Buffer.alloc(0)))).toThrow(
      /base is invalid/i,
    )
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

  it("accepts bounded fault receipts and refuses malformed or unrelated fault data", () => {
    const fault = { v: 1, type: "error", code: "native_fault", fault: "C0000005:main+0x12AB" }
    expect(new NativeFrameParser().push(encode(fault, Buffer.alloc(0)))).toEqual([
      { type: "error", code: "native_fault", fault: "C0000005:main+0x12AB" },
    ])
    expect(
      new NativeFrameParser().push(encode({ ...fault, fault: "C0000005:KERNELBASE.dll+0x123" }, Buffer.alloc(0))),
    ).toEqual([{ type: "error", code: "native_fault", fault: "C0000005:KERNELBASE.dll+0x123" }])
    expect(() =>
      new NativeFrameParser().push(encode({ ...fault, fault: "C0000005:main+0x12AB;secret" }, Buffer.alloc(0))),
    ).toThrow(/fault receipt is invalid/i)
    expect(() => new NativeFrameParser().push(encode({ ...fault, fault: undefined }, Buffer.alloc(0)))).toThrow(
      /fault receipt is invalid/i,
    )
    expect(() =>
      new NativeFrameParser().push(encode({ ...fault, fault: "C0000005:C:\\secret+0x12AB" }, Buffer.alloc(0))),
    ).toThrow(/fault receipt is invalid/i)
    expect(() => new NativeFrameParser().push(encode({ ...fault, code: "device_lost" }, Buffer.alloc(0)))).toThrow(
      /fault receipt is unexpected/i,
    )
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
