import { describe, expect, it } from "bun:test"
import { NativeCaptureHost } from "../../src/services/computer-use/desktop-native-host"

function encode(header: Record<string, unknown>, image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])) {
  const json = Buffer.from(JSON.stringify(header))
  const result = Buffer.alloc(8 + json.length + image.length)
  result.writeUInt32LE(json.length, 0)
  json.copy(result, 4)
  result.writeUInt32LE(image.length, 4 + json.length)
  image.copy(result, 8 + json.length)
  return result
}

function child(packet: Buffer, keep = true) {
  const data = packet.toString("base64")
  return `process.stdout.write(Buffer.from(${JSON.stringify(data)}, "base64")); ${keep ? "setInterval(() => {}, 1000)" : ""}`
}

async function until(check: () => boolean) {
  for (let index = 0; index < 100 && !check(); index++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

describe("native desktop capture host", () => {
  it("keeps one bounded binary frame and clears it immediately on Stop", async () => {
    const errors: Error[] = []
    const header = {
      v: 1,
      type: "frame",
      sequence: 1,
      windowID: "0x12AB",
      location: "pid:42;title:Editor;bounds:0,0,100,80",
      width: 100,
      height: 80,
      mime: "image/png",
      acquisitionMs: 2,
      preparationMs: 3,
    }
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(encode(header))])
    host.start()
    await until(() => !!host.latest())
    const result = host.latest()
    expect(result).toMatchObject({ sequence: 1, windowID: "0x12AB", width: 100 })
    expect(result?.data[0]).toBe(137)
    expect(host.latest(125, 1)).toBeUndefined()
    host.stop()
    expect(host.latest()).toBeUndefined()
    await Bun.sleep(20)
    expect(errors).toHaveLength(0)
  })

  it("fails closed on a partial child stream without restarting it", async () => {
    const errors: Error[] = []
    const packet = encode({ v: 1, type: "error", code: "device_lost" }, Buffer.alloc(0)).subarray(0, 10)
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(packet, false)])
    host.start()
    await until(() => errors.length === 1)
    expect(errors[0]?.message).toMatch(/partial packet/i)
    expect(host.latest()).toBeUndefined()
    await Bun.sleep(20)
    expect(errors).toHaveLength(1)
  })

  it("stops on an explicit native error and never retains late pixels after Stop", async () => {
    const errors: Error[] = []
    const terminal = new NativeCaptureHost(process.execPath, (error) => errors.push(error), [
      "-e",
      child(encode({ v: 1, type: "error", code: "device_lost" }, Buffer.alloc(0))),
    ])
    terminal.start()
    await until(() => errors.length === 1)
    expect(errors[0]?.message).toContain("device_lost")
    expect(terminal.latest()).toBeUndefined()

    const header = {
      v: 1,
      type: "frame",
      sequence: 1,
      windowID: "0x12AB",
      location: "pid:42;title:Editor;bounds:0,0,100,80",
      width: 100,
      height: 80,
      mime: "image/png",
      acquisitionMs: 0,
      preparationMs: 0,
    }
    const data = encode(header).toString("base64")
    const script = `setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify(data)}, "base64")), 100); setInterval(() => {}, 1000)`
    const late = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script])
    late.start()
    late.stop()
    await Bun.sleep(150)
    expect(late.latest()).toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
