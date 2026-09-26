import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const visual = {
    v: 1,
    type: "frame",
    sequence: 1,
    windowID: "0x12AB",
    location: "pid:42;title:Editor;bounds:0,0,100,80",
    width: 100,
    height: 80,
    mime: "image/png",
    acquisitionMs: 1,
    preparationMs: 1,
  }
  const request = {
    request: "a".repeat(32),
    scene: 7,
    source: 1,
    windowID: visual.windowID,
    location: visual.location,
    identity: "A".repeat(64),
  }

  it("clears old pixels on reset while a frame waiter continues to the new epoch", async () => {
    const errors: Error[] = []
    const resets: number[] = []
    const first = encode({ ...visual, v: 3, epoch: 1 }).toString("base64")
    const marker = encode({ v: 3, type: "reset", epoch: 2, reason: "target_changed" }, Buffer.alloc(0)).toString(
      "base64",
    )
    const second = encode({ ...visual, v: 3, epoch: 2, sequence: 2, windowID: "0x34AB" }).toString("base64")
    const script = `process.stdout.write(Buffer.from(${JSON.stringify(first)},"base64"));setTimeout(()=>process.stdout.write(Buffer.from(${JSON.stringify(marker)},"base64")),20);setTimeout(()=>process.stdout.write(Buffer.from(${JSON.stringify(second)},"base64")),120);setInterval(()=>{},1000)`
    const host = new NativeCaptureHost(
      process.execPath,
      (error) => errors.push(error),
      ["-e", script],
      undefined,
      undefined,
      (reset) => resets.push(reset.epoch),
    )
    host.start()
    expect((await host.next()).epoch).toBe(1)
    const pending = host.next(1)
    await until(() => resets.length === 1)
    expect(host.latest(Infinity)).toBeUndefined()
    expect((await pending).windowID).toBe("0x34AB")
    expect(host.latest(Infinity)?.epoch).toBe(2)
    expect(errors).toHaveLength(0)
    host.stop()
  })

  it("rejects an outstanding post-action proof on reset without replaying it", async () => {
    const errors: Error[] = []
    const first = encode({ ...visual, v: 3, epoch: 1 }).toString("base64")
    const marker = encode({ v: 3, type: "reset", epoch: 2, reason: "display_changed" }, Buffer.alloc(0)).toString(
      "base64",
    )
    const script = `process.stdout.write(Buffer.from(${JSON.stringify(first)},"base64"));process.stdin.once("data",()=>process.stdout.write(Buffer.from(${JSON.stringify(marker)},"base64")));setInterval(()=>{},1000)`
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script])
    host.start()
    await host.next()
    const result = await host.barrierAfter(request).catch((error: Error) => error)
    expect(errors).toHaveLength(0)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/display_changed/)
    expect(host.latest(Infinity)).toBeUndefined()
    expect(errors).toHaveLength(0)
    host.stop()
  })

  it("delivers only a matching post-action v2 image as barrier proof", async () => {
    const errors: Error[] = []
    const base = encode(visual).toString("base64")
    const script = `const send=(h,i)=>{const j=Buffer.from(JSON.stringify(h));const p=Buffer.alloc(8+j.length+i.length);p.writeUInt32LE(j.length,0);j.copy(p,4);p.writeUInt32LE(i.length,4+j.length);i.copy(p,8+j.length);process.stdout.write(p)};process.stdout.write(Buffer.from(${JSON.stringify(base)},"base64"));let b=Buffer.alloc(0);process.stdin.on("data",c=>{b=Buffer.concat([b,c]);if(b.length<148)return;if(b.toString("ascii",0,4)!=="RCB2"||b.readUInt32LE(4)!==148||b.readBigUInt64LE(16)!==1n)return;const h=${JSON.stringify(visual)};h.v=2;h.sequence=2;h.request=b.toString("ascii",52,84);h.scene=Number(b.readBigUInt64LE(8));h.source=Number(b.readBigUInt64LE(16));h.receiptQpc="100";h.presentQpc="101";send(h,Buffer.from([137,80,78,71,13,10,26,10,2]))});setInterval(()=>{},1000)`
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script])
    host.start()
    expect(host.pid()).toBeGreaterThan(0)
    await host.next()
    const result = await host.barrierAfter(request)
    expect(result.status).toBe("proven")
    if (result.status === "proven") {
      expect(result.frame.barrier).toMatchObject({ request: request.request, scene: 7, source: 1 })
      expect(result.frame.data.at(-1)).toBe(2)
    }
    expect(errors).toHaveLength(0)
    host.stop()
    expect(host.pid()).toBeUndefined()
  })

  it("returns an unproven barrier without promoting cached pixels", async () => {
    const errors: Error[] = []
    const base = encode(visual).toString("base64")
    const script = `const send=h=>{const j=Buffer.from(JSON.stringify(h));const p=Buffer.alloc(8+j.length);p.writeUInt32LE(j.length,0);j.copy(p,4);process.stdout.write(p)};process.stdout.write(Buffer.from(${JSON.stringify(base)},"base64"));process.stdin.once("data",b=>send({v:2,type:"barrier",status:"unproven",reason:"no_present",request:b.toString("ascii",52,84),scene:Number(b.readBigUInt64LE(8)),source:Number(b.readBigUInt64LE(16)),receiptQpc:"100"}));setInterval(()=>{},1000)`
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script])
    host.start()
    await host.next()
    expect(await host.barrierAfter(request)).toMatchObject({ status: "unproven", reason: "no_present" })
    expect(host.latest(Infinity)?.sequence).toBe(1)
    expect(host.latest(Infinity)?.barrier).toBeUndefined()
    expect(errors).toHaveLength(0)
    host.stop()
  })

  it("rejects a request-matched proof if its target location changed", async () => {
    const errors: Error[] = []
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(encode(visual))])
    host.start()
    const frame = await host.next()
    const pending = host.barrierAfter(request)
    expect(() =>
      (host as unknown as { accept: (packet: unknown) => void }).accept({
        type: "frame",
        frame: {
          ...frame,
          sequence: 2,
          location: "pid:43;title:Editor;bounds:0,0,100,80",
          barrier: { request: request.request, scene: 7, source: 1, receiptQpc: "100", presentQpc: "101" },
        },
      }),
    ).toThrow(/matching target/i)
    host.stop()
    await expect(pending).rejects.toThrow(/stopped/i)
    expect(errors).toHaveLength(0)
  })

  it("rejects stale, retargeted, and interrupted barrier claims", async () => {
    const errors: Error[] = []
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(encode(visual))])
    host.start()
    await host.next()
    await expect(host.barrierAfter({ ...request, source: 2 })).rejects.toThrow(/target or scene/i)
    await expect(host.barrierAfter({ ...request, location: "pid:99;title:Editor;bounds:0,0,100,80" })).rejects.toThrow(
      /target or scene/i,
    )
    const pending = host.barrierAfter(request)
    host.stop()
    await expect(pending).rejects.toThrow(/stopped/i)
    host.start()
    expect((await host.next()).sequence).toBe(1)
    expect(errors).toHaveLength(0)
    host.stop()
  })

  it("ignores a delayed write failure from a stopped capture generation", async () => {
    const errors: Error[] = []
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(encode(visual))])
    host.start()
    await host.next()
    const childProcess = (
      host as unknown as { process: { stdin: { write: (data: Buffer, callback: (error?: Error) => void) => boolean } } }
    ).process
    let complete: ((error?: Error) => void) | undefined
    childProcess.stdin.write = (_data, callback) => {
      complete = callback
      return true
    }
    const pending = host.barrierAfter(request)
    host.stop()
    await expect(pending).rejects.toThrow(/stopped/i)
    host.start()
    expect((await host.next()).sequence).toBe(1)
    complete?.(new Error("old pipe closed"))
    await Bun.sleep(5)
    expect(host.latest()?.sequence).toBe(1)
    expect(errors).toHaveLength(0)
    host.stop()
  })

  it("reports a capture child that survives Stop even after a new host starts", async () => {
    const errors: Error[] = []
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", child(encode(visual))])
    host.start()
    await host.next()
    const old = (host as unknown as { process: { kill: (signal?: string) => boolean } }).process
    const kill = old.kill.bind(old)
    old.kill = () => true
    try {
      host.stop()
      host.start()
      expect((await host.next()).sequence).toBe(1)
      await Bun.sleep(1_600)
      expect(host.latest(Infinity)?.sequence).toBe(1)
      expect(errors.map((error) => error.message)).toContain("Native desktop capture did not exit after Stop")
    } finally {
      kill("SIGKILL")
      host.stop()
    }
  })

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

  it("recovers a bounded local fault receipt when the native pipe closes first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raya-fault-host-"))
    const errors: Error[] = []
    const script =
      "require('node:fs').writeFileSync(process.env.RAYA_NATIVE_FAULT_RECEIPT, 'C0000005:main+0x0000000000001234\\n'); process.exit(1)"
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script], undefined, dir)
    try {
      host.start()
      await until(() => errors.length === 1)
      expect(errors[0]?.message).toContain("fault receipt (C0000005:main+0x0000000000001234)")
      expect(host.latest()).toBeUndefined()
      const files = readdirSync(dir)
      expect(files).toHaveLength(1)
      expect(readFileSync(join(dir, files[0]!), "ascii")).toBe("C0000005:main+0x0000000000001234\n")
    } finally {
      host.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects and removes an oversized local fault receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raya-fault-host-"))
    const errors: Error[] = []
    const script =
      "require('node:fs').writeFileSync(process.env.RAYA_NATIVE_FAULT_RECEIPT, 'X'.repeat(65)); process.exit(1)"
    const host = new NativeCaptureHost(process.execPath, (error) => errors.push(error), ["-e", script], undefined, dir)
    try {
      host.start()
      await until(() => errors.length === 1)
      expect(errors[0]?.message).toContain("invalid bounded receipt")
      expect(readdirSync(dir)).toHaveLength(0)
    } finally {
      host.stop()
      rmSync(dir, { recursive: true, force: true })
    }
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
