import { spawn, type ChildProcess } from "node:child_process"
import { NativeFrameParser, type NativeFrame, type NativeUnchanged } from "./desktop-native-frame"

export class NativeCaptureHost {
  private process: ChildProcess | undefined
  private parser: NativeFrameParser | undefined
  private frame: (NativeFrame & { receivedAt: number }) | undefined
  private waiting: { after: number; resolve: (frame: NativeFrame) => void; reject: (error: Error) => void } | undefined
  private generation = 0

  constructor(
    private readonly binary: string,
    private readonly failed: (error: Error) => void,
    private readonly args: string[] = [],
    private readonly renewed?: (frame: NativeUnchanged) => void,
  ) {}

  start(): void {
    if (this.process) return
    const generation = ++this.generation
    const parser = new NativeFrameParser()
    const child = spawn(this.binary, this.args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
    this.parser = parser
    this.process = child
    child.stdout?.on("data", (chunk: Buffer) => {
      if (generation !== this.generation) return
      try {
        for (const result of parser.push(chunk)) {
          if (result.type === "error")
            throw new Error(`Native desktop capture stopped: ${result.code}${result.fault ? ` (${result.fault})` : ""}`)
          if (result.type === "unchanged") {
            if (!this.frame || result.frame.base !== this.frame.sequence)
              throw new Error("Native desktop continuity has no matching image")
            this.frame.receivedAt = performance.now()
            this.renewed?.(result.frame)
            continue
          }
          this.frame?.data.fill(0)
          this.frame = { ...result.frame, receivedAt: performance.now() }
          if (this.waiting && result.frame.sequence > this.waiting.after) {
            const waiting = this.waiting
            this.waiting = undefined
            waiting.resolve({ ...result.frame, data: Buffer.from(result.frame.data) })
          }
        }
      } catch (error) {
        this.fail(error, generation)
      }
    })
    child.on("error", (error) => this.fail(error, generation))
    child.on("close", (code) => {
      if (generation !== this.generation) return
      try {
        parser.finish()
        const status = code === null ? "unknown" : `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
        this.fail(new Error(`Native desktop capture exited before Stop (${status})`), generation)
      } catch (error) {
        this.fail(error, generation)
      }
    })
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

  stop(): void {
    this.generation++
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
