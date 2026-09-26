import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import {
  NativeFrameParser,
  type NativeBarrier,
  type NativeFrame,
  type NativePacket,
  type NativeReset,
  type NativeUnchanged,
} from "./desktop-native-frame"

type BarrierRequest = {
  request: string
  scene: number
  source: number
  windowID: string
  location: string
  identity: string
}
export type BarrierResult = { status: "proven"; frame: NativeFrame } | NativeBarrier

function verify(value: BarrierRequest, frame: NativeFrame): void {
  if (
    !/^[0-9a-f]{32}$/.test(value.request) ||
    !Number.isSafeInteger(value.scene) ||
    value.scene < 1 ||
    !Number.isSafeInteger(value.source) ||
    value.source < 1 ||
    value.source !== frame.sequence ||
    value.windowID !== frame.windowID ||
    value.location !== frame.location ||
    !/^[0-9A-F]{64}$/.test(value.identity)
  )
    throw new Error("Native desktop barrier target or scene is invalid")
}

function target(value: BarrierRequest, frame: NativeFrame) {
  verify(value, frame)
  const match = /^pid:(\d+);title:[\s\S]*;bounds:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(value.location)
  const handle = /^0x[0-9A-F]+$/.test(value.windowID) ? BigInt(value.windowID) : 0n
  const pid = Number(match?.[1])
  const left = Number(match?.[2])
  const top = Number(match?.[3])
  const width = Number(match?.[4])
  const height = Number(match?.[5])
  const right = left + width
  const bottom = top + height
  if (
    !match ||
    handle < 1n ||
    handle > 0xffffffffffffffffn ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid > 0xffffffff ||
    width !== frame.width ||
    height !== frame.height ||
    ![left, top, right, bottom].every(
      (number) => Number.isSafeInteger(number) && number >= -2147483648 && number <= 2147483647,
    )
  )
    throw new Error("Native desktop barrier window bounds are invalid")
  return { handle, pid, left, top, right, bottom }
}

function command(value: BarrierRequest, frame: NativeFrame): Buffer {
  const bounds = target(value, frame)
  const data = Buffer.alloc(148)
  data.write("RCB2", 0, "ascii")
  data.writeUInt32LE(data.length, 4)
  data.writeBigUInt64LE(BigInt(value.scene), 8)
  data.writeBigUInt64LE(BigInt(value.source), 16)
  data.writeBigUInt64LE(bounds.handle, 24)
  data.writeUInt32LE(bounds.pid, 32)
  for (const [index, coord] of [bounds.left, bounds.top, bounds.right, bounds.bottom].entries())
    data.writeInt32LE(coord, 36 + index * 4)
  data.write(value.request, 52, 32, "ascii")
  data.write(value.identity, 84, 64, "ascii")
  return data
}

export class NativeCaptureHost {
  private process: ChildProcess | undefined
  private parser: NativeFrameParser | undefined
  private frame: (NativeFrame & { receivedAt: number }) | undefined
  private waiting: { after: number; resolve: (frame: NativeFrame) => void; reject: (error: Error) => void } | undefined
  private barrier:
    | {
        request: BarrierRequest
        resolve: (result: BarrierResult) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  private generation = 0

  constructor(
    private readonly binary: string,
    private readonly failed: (error: Error) => void,
    private readonly args: string[] = [],
    private readonly renewed?: (frame: NativeUnchanged) => void,
    private readonly dir?: string,
    private readonly reset?: (reset: NativeReset) => void,
  ) {}

  start(): void {
    if (this.process) return
    const generation = ++this.generation
    const parser = new NativeFrameParser()
    const receipt = this.dir ? this.path() : undefined
    const child = spawn(this.binary, this.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      ...(receipt ? { env: { ...process.env, RAYA_NATIVE_FAULT_RECEIPT: receipt } } : {}),
    })
    this.parser = parser
    this.process = child
    child.stdout?.on("data", (chunk: Buffer) => {
      if (generation !== this.generation) return
      try {
        for (const result of parser.push(chunk)) this.accept(result)
      } catch (error) {
        this.fail(error, generation)
      }
    })
    child.on("error", (error) => this.fail(error, generation))
    child.on("close", (code) => {
      const fault = receipt ? this.receipt(receipt) : undefined
      if (generation !== this.generation) return
      if (fault) {
        this.fail(new Error(`Native desktop capture fault receipt (${fault})`), generation)
        return
      }
      try {
        parser.finish()
        const status = code === null ? "unknown" : `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
        this.fail(new Error(`Native desktop capture exited before Stop (${status})`), generation)
      } catch (error) {
        this.fail(error, generation)
      }
    })
  }

  private accept(result: NativePacket): void {
    if (result.type === "error")
      throw new Error(`Native desktop capture stopped: ${result.code}${result.fault ? ` (${result.fault})` : ""}`)
    if (result.type === "barrier") {
      const pending = this.barrier
      if (
        !pending ||
        result.barrier.request !== pending.request.request ||
        result.barrier.scene !== pending.request.scene ||
        result.barrier.source !== pending.request.source
      )
        throw new Error("Native desktop barrier response has no matching request")
      this.barrier = undefined
      clearTimeout(pending.timer)
      pending.resolve(result.barrier)
      return
    }
    if (result.type === "reset") {
      this.frame?.data.fill(0)
      this.frame = undefined
      if (this.barrier) {
        const pending = this.barrier
        this.barrier = undefined
        clearTimeout(pending.timer)
        pending.reject(new Error(`Native desktop post-action ${result.reset.reason} during capture reset`))
      }
      this.reset?.(result.reset)
      return
    }
    if (result.type === "unchanged") {
      if (!this.frame || result.frame.base !== this.frame.sequence)
        throw new Error("Native desktop continuity has no matching image")
      this.frame.receivedAt = performance.now()
      this.renewed?.(result.frame)
      return
    }
    if (result.frame.barrier) this.confirm(result.frame)
    this.frame?.data.fill(0)
    this.frame = { ...result.frame, receivedAt: performance.now() }
    if (this.waiting && result.frame.sequence > this.waiting.after) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting.resolve({ ...result.frame, data: Buffer.from(result.frame.data) })
    }
  }

  private confirm(frame: NativeFrame): void {
    const proof = frame.barrier!
    const pending = this.barrier
    if (
      !pending ||
      proof.request !== pending.request.request ||
      proof.scene !== pending.request.scene ||
      proof.source !== pending.request.source ||
      frame.windowID !== pending.request.windowID ||
      frame.location !== pending.request.location ||
      !this.frame ||
      frame.epoch !== this.frame.epoch ||
      this.frame.sequence !== pending.request.source
    )
      throw new Error("Native desktop post-action image has no matching target or request")
    this.barrier = undefined
    clearTimeout(pending.timer)
    pending.resolve({ status: "proven", frame: { ...frame, data: Buffer.from(frame.data) } })
  }

  private path(): string {
    const dir = this.dir!
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const saved = readdirSync(dir)
      .filter((name) => /^capture-[a-f0-9]{16}-[a-f0-9-]{36}\.txt$/.test(name))
      .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    for (const item of saved.slice(3)) {
      try {
        unlinkSync(join(dir, item.name))
      } catch (error) {
        console.error("[Raya] Old native desktop fault receipt could not be removed", error)
      }
    }
    const hash = createHash("sha256").update(readFileSync(this.binary)).digest("hex").slice(0, 16)
    return join(dir, `capture-${hash}-${randomUUID()}.txt`)
  }

  private receipt(path: string): string | undefined {
    try {
      if (!existsSync(path)) return
      const size = statSync(path).size
      if (!size) {
        unlinkSync(path)
        return
      }
      if (size > 64) {
        unlinkSync(path)
        return "invalid bounded receipt"
      }
      const value = readFileSync(path, "ascii")
      if (/^[0-9A-F]{8}:(?:main\+0x[0-9A-F]{16}|external\+0x0)\n$/.test(value)) return value.trim()
      unlinkSync(path)
      return "invalid bounded receipt"
    } catch (error) {
      console.error("[Raya] Native desktop fault receipt could not be read", error)
      return "receipt unavailable"
    }
  }

  pid(): number | undefined {
    return this.process?.pid
  }

  latest(maxAgeMs = 125, after = 0): NativeFrame | undefined {
    const frame = this.frame
    if (!this.process || !frame || frame.sequence <= after || performance.now() - frame.receivedAt > maxAgeMs) return
    return { ...frame, data: Buffer.from(frame.data) }
  }

  next(after = 0): Promise<NativeFrame> {
    if (!this.process) return Promise.reject(new Error("Native desktop capture is stopped"))
    const frame = this.latest(Infinity, after)
    if (frame) return Promise.resolve(frame)
    if (this.waiting) return Promise.reject(new Error("Native desktop capture already has a frame waiter"))
    return new Promise((resolve, reject) => {
      this.waiting = { after, resolve, reject }
    })
  }

  async barrierAfter(value: BarrierRequest): Promise<BarrierResult> {
    const child = this.process
    const frame = this.frame
    if (!child?.stdin || !frame) return Promise.reject(new Error("Native desktop capture has no active image"))
    if (this.barrier) return Promise.reject(new Error("Native desktop barrier already has a request"))
    const data = command(value, frame)
    const generation = this.generation
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Native desktop post-action barrier timed out"), generation),
        1_500,
      )
      this.barrier = { request: value, resolve, reject, timer }
      child.stdin!.write(data, (error) => {
        data.fill(0)
        if (error) this.fail(error, generation)
      })
    })
  }

  stop(): void {
    this.generation++
    if (this.barrier) {
      clearTimeout(this.barrier.timer)
      this.barrier.reject(new Error("Native desktop capture stopped during post-action barrier"))
      this.barrier = undefined
    }
    this.waiting?.reject(new Error("Native desktop capture stopped"))
    this.waiting = undefined
    this.parser?.clear()
    this.parser = undefined
    this.frame?.data.fill(0)
    this.frame = undefined
    const child = this.process
    this.process = undefined
    if (!child) return
    child.stdout?.destroy()
    child.stdin?.destroy()
    child.kill()
    const retry = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGKILL")
    }, 500)
    const alarm = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      this.failed(new Error("Native desktop capture did not exit after Stop"))
    }, 1_500)
    retry.unref()
    alarm.unref()
    child.once("close", () => {
      clearTimeout(retry)
      clearTimeout(alarm)
    })
  }

  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation) return
    this.stop()
    this.failed(error instanceof Error ? error : new Error(String(error)))
  }
}
