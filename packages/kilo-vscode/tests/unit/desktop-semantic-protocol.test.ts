import { describe, expect, it } from "bun:test"
import { clock, encode, parse, type Request } from "../../src/services/computer-use/desktop-semantic-protocol"

const request: Request = {
  request: "a".repeat(32),
  generation: 7,
  windowID: "0xABCD",
  identity: "F".repeat(64),
  location: "pid:123;title:Unicode 🎻;bounds:-1200,40,1000,600",
}
const viewport = { x: -1200, y: 40, width: 1000, height: 600 }

function reply() {
  return {
    version: 1,
    request: request.request,
    generation: request.generation,
    windowID: request.windowID,
    identity: request.identity,
    viewport,
    clock: { version: 1, acquisition: "9007199254740993", prepared: "9007199254740995", frequency: "10000000" },
    semantics: {
      source: "windows_ui_automation",
      status: "available",
      viewport,
      truncated: false,
      controls: [
        {
          controlID: "uia:1",
          role: "Button",
          name: "Save",
          automationID: "save",
          x: -1100,
          y: 50,
          width: 100,
          height: 30,
          enabled: true,
          focused: false,
          actions: ["invoke"],
        },
      ],
    },
  }
}

describe("native semantic protocol", () => {
  it("encodes exact 144-byte little-endian admission identity without titles", () => {
    const data = encode(request)
    expect(data.length).toBe(144)
    expect(data.subarray(0, 4).toString("ascii")).toBe("RYSM")
    expect(data.readUInt32LE(4)).toBe(1)
    expect(data.readUInt32LE(8)).toBe(144)
    expect(data.readBigUInt64LE(12)).toBe(7n)
    expect(data.readBigUInt64LE(20)).toBe(0xabcdn)
    expect(data.readUInt32LE(28)).toBe(123)
    expect([32, 36, 40, 44].map((offset) => data.readInt32LE(offset))).toEqual([-1200, 40, -200, 640])
    expect(data.subarray(48, 112).toString()).toBe(request.identity)
    expect(data.subarray(112).toString()).toBe(request.request)
    expect(data.includes(Buffer.from("Unicode"))).toBe(false)
  })

  it("preserves signed64 QPC precision and native semantic controls", () => {
    const output = parse(Buffer.from(JSON.stringify(reply())), request)
    expect(output).toEqual(reply())
    expect(
      clock(
        {
          version: 1,
          type: "clock",
          request: request.request,
          generation: 7,
          qpc: "9223372036854775807",
          frequency: "10000000",
        },
        request,
      ).qpc,
    ).toBe("9223372036854775807")
  })

  it("rejects malformed and noncanonical request admission", () => {
    const cases = [
      { generation: 0 },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { request: "A".repeat(32) },
      { identity: "f".repeat(64) },
      { windowID: "43981" },
      { windowID: "0x0" },
      { windowID: "0x0ABCD" },
      { windowID: "0xabcd" },
      { location: "pid:0;title:x;bounds:0,0,1,1" },
      { location: "pid:1;title:x;bounds:2147483647,0,1,1" },
      { location: "pid:1;title:x;bounds:0,0,0,1" },
    ]
    for (const input of cases) expect(() => encode({ ...request, ...input })).toThrow()
  })

  it("refuses changed request, target, bounds and extra reply fields", () => {
    const cases = [
      { request: "b".repeat(32) },
      { generation: 8 },
      { windowID: "0xABCE" },
      { identity: "A".repeat(64) },
      { viewport: { ...viewport, x: -1199 } },
      { version: 2 },
      { data: "secret pixels" },
      { type: "success" },
    ]
    for (const input of cases) expect(() => parse({ ...reply(), ...input }, request)).toThrow()
    expect(() =>
      parse({ ...reply(), semantics: { ...reply().semantics, viewport: { ...viewport, width: 999 } } }, request),
    ).toThrow()
  })

  it("refuses unsafe clocks and stale calibration identity", () => {
    for (const input of [
      { acquisition: "0" },
      { acquisition: "01" },
      { prepared: "1" },
      { frequency: "10000000001" },
      { acquisition: "9223372036854775808" },
      { acquisition: 1 },
      { prepared: "-1" },
      { value: "secret" },
    ]) {
      expect(() => parse({ ...reply(), clock: { ...reply().clock, ...input } }, request)).toThrow()
    }
    const input = { version: 1, type: "clock", request: request.request, generation: 7, qpc: "1", frequency: "1" }
    for (const changed of [
      { generation: 8 },
      { request: "b".repeat(32) },
      { qpc: "0" },
      { frequency: "10000000001" },
      { other: 1 },
    ])
      expect(() => clock({ ...input, ...changed }, request)).toThrow()
  })

  it("refuses control values, private names, duplicate IDs and overlong metadata", () => {
    const original = reply().semantics.controls[0]!
    for (const changed of [
      { value: "typed secret" },
      { role: "Edit", name: "password" },
      { role: "Document", name: "private content" },
      { role: "Password", name: "secret" },
      { name: "x".repeat(513) },
      { controlID: "x".repeat(201) },
      { actions: ["invoke", "invoke"] },
      { actions: ["execute"] },
      { enabled: 1 },
      { width: -1 },
      { x: Number.MAX_SAFE_INTEGER },
      { selected: null },
    ]) {
      expect(() =>
        parse({ ...reply(), semantics: { ...reply().semantics, controls: [{ ...original, ...changed }] } }, request),
      ).toThrow()
    }
    expect(() =>
      parse({ ...reply(), semantics: { ...reply().semantics, controls: [original, original] } }, request),
    ).toThrow()
    expect(() =>
      parse(
        {
          ...reply(),
          semantics: {
            ...reply().semantics,
            controls: Array.from({ length: 257 }, (_, i) => ({ ...original, controlID: `uia:${i}` })),
          },
        },
        request,
      ),
    ).toThrow()
    expect(() => parse({ ...reply(), semantics: { ...reply().semantics, status: "unavailable" } }, request)).toThrow()
    expect(
      parse({ ...reply(), semantics: { ...reply().semantics, status: "unavailable", controls: [] } }, request),
    ).toHaveProperty("semantics.status", "unavailable")
  })

  it("rejects prototypes, accessors, duplicate JSON keys, malformed UTF8 and oversized output", () => {
    expect(() => parse(Object.assign(Object.create({ injected: true }), reply()), request)).toThrow()
    const input = reply()
    Object.defineProperty(input, "identity", {
      get: () => {
        throw new Error("getter was evaluated")
      },
      enumerable: true,
    })
    expect(() => parse(input, request)).toThrow("Native desktop semantic protocol is invalid")
    expect(() => parse(JSON.stringify(reply()).replace('"version":1', '"version":1,"version":1'), request)).toThrow()
    expect(() =>
      parse(JSON.stringify(reply()).replace('"version":1', '"version":1,"\\u0076ersion":1'), request),
    ).toThrow()
    expect(() => parse(Buffer.from([0xc3, 0x28]), request)).toThrow()
    expect(() => parse('{"private":"typed secret" malformed}', request)).toThrow(
      "Native desktop semantic protocol is invalid",
    )
    expect(() => parse(Buffer.alloc(1_048_577), request)).toThrow()
    expect(() => parse(" ".repeat(1_048_577), request)).toThrow()
    const hole = reply()
    hole.semantics.controls = Array(1)
    expect(() => parse(hole, request)).toThrow()
    const accessor = reply()
    Object.defineProperty(accessor.semantics.controls, "0", {
      get: () => {
        throw new Error("array getter was evaluated")
      },
      enumerable: true,
    })
    expect(() => parse(accessor, request)).toThrow("Native desktop semantic protocol is invalid")
    const inherited = reply()
    Object.setPrototypeOf(inherited.semantics.controls, { ...Array.prototype })
    expect(() => parse(inherited, request)).toThrow()
  })

  it("accepts only correlated exact error envelopes", () => {
    const input = { version: 1, request: request.request, generation: 7, type: "error", code: "target_changed" }
    expect(parse(input, request)).toEqual(input)
    for (const changed of [
      { code: "secret text" },
      { generation: 8 },
      { windowID: request.windowID },
      { code: "X" },
      { code: "x".repeat(81) },
    ])
      expect(() => parse({ ...input, ...changed }, request)).toThrow()
  })
})
