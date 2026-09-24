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

  const windows = process.platform === "win32" ? it : it.skip
  windows("reports a nonzero native exit and retains no frame", async () => {
    const errors: Error[] = []
    const host = new NativeCaptureHost("cmd.exe", (error) => errors.push(error), [
      "/d",
      "/c",
      "exit",
      "/b",
      "-1073741819",
    ])
    host.start()
    await until(() => errors.length === 1)
    expect(errors[0]?.message).toContain("0x00000005")
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

  it("reports a native fault offset without retaining pixels or restarting", async () => {
    const errors: Error[] = []
    const packet = encode({ v: 1, type: "error", code: "native_fault", fault: "C0000005:main+0x12AB" }, Buffer.alloc(0))
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(packet, false)])
    host.start()
    await until(() => errors.length === 1)
    expect(errors[0]?.message).toContain("native_fault (C0000005:main+0x12AB)")
    expect(host.latest()).toBeUndefined()
    await Bun.sleep(20)
    expect(errors).toHaveLength(1)
  })

  it("delivers only newer frames to one waiter and cancels a pending wait on Stop", async () => {
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
    const packet = encode(header).toString("base64")
    const script = `setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify(packet)}, "base64")), 25); setInterval(() => {}, 1000)`
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script])
    host.start()
    const first = await host.next()
    expect(first.sequence).toBe(1)
    expect(first.data[0]).toBe(137)
    const pending = host.next(1)
    await expect(host.next(1)).rejects.toThrow(/already has a frame waiter/i)
    host.stop()
    await expect(pending).rejects.toThrow(/stopped/i)
    expect(first.data[0]).toBe(137)
    expect(host.latest()).toBeUndefined()
    expect(errors).toHaveLength(0)
  })

  it("rejects a pending waiter once when the native stream fails", async () => {
    const errors: Error[] = []
    const packet = encode({ v: 1, type: "error", code: "device_lost" }, Buffer.alloc(0))
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(packet)])
    host.start()
    await expect(host.next()).rejects.toThrow(/stopped/i)
    await until(() => errors.length === 1)
    expect(errors[0]?.message).toContain("device_lost")
    expect(host.latest()).toBeUndefined()
  })

  it("terminates the native child after Stop, beyond clearing its retained frame", async () => {
    const errors: Error[] = []
    const header = {
      v: 1,
      type: "frame",
      sequence: 1,
      windowID: "0x12AB",
      location: "pid:0;title:Editor;bounds:0,0,100,80",
      width: 100,
      height: 80,
      mime: "image/png",
      acquisitionMs: 1,
      preparationMs: 1,
    }
    const script = `const h=${JSON.stringify(header)};h.location="pid:"+process.pid+";title:Editor;bounds:0,0,100,80";const j=Buffer.from(JSON.stringify(h));const p=Buffer.alloc(8+j.length+9);p.writeUInt32LE(j.length,0);j.copy(p,4);p.writeUInt32LE(9,4+j.length);Buffer.from([137,80,78,71,13,10,26,10,1]).copy(p,8+j.length);process.stdout.write(p);setInterval(()=>{},1000)`
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script])
    host.start()
    const frame = await host.next()
    const pid = Number(frame.location.match(/^pid:(\d+);/)?.[1])
    host.stop()
    expect(Number.isInteger(pid)).toBe(true)
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    expect(host.latest()).toBeUndefined()
    expect(errors).toHaveLength(0)
  })

  it("renews an exact unchanged image without delivering a second full frame", async () => {
    const errors: Error[] = []
    const renewed: number[] = []
    const target = {
      windowID: "0x12AB",
      location: "pid:42;title:Editor;bounds:0,0,100,80",
      width: 100,
      height: 80,
    }
    const full = encode({
      v: 1,
      type: "frame",
      sequence: 1,
      ...target,
      mime: "image/png",
      acquisitionMs: 1,
      preparationMs: 1,
    })
    const unchanged = encode({ v: 1, type: "unchanged", sequence: 2, base: 1, ...target }, Buffer.alloc(0))
    const script = `process.stdout.write(Buffer.from(${JSON.stringify(full.toString("base64"))},"base64"));setTimeout(()=>process.stdout.write(Buffer.from(${JSON.stringify(unchanged.toString("base64"))},"base64")),50);setInterval(()=>{},1000)`
    const host = new NativeCaptureHost(
      process.execPath,
      (error) => errors.push(error),
      ["-e", script],
      (frame) => {
        renewed.push(frame.base)
      },
    )
    host.start()
    expect((await host.next()).sequence).toBe(1)
    await until(() => renewed.length === 1)
    expect(renewed).toEqual([1])
    expect(host.latest()?.sequence).toBe(1)
    const pending = host.next(1)
    host.stop()
    await expect(pending).rejects.toThrow(/stopped/i)
    expect(errors).toHaveLength(0)
  })
})
