import { spawn, type ChildProcess } from "node:child_process"
import { NativeFrameParser, type NativeFrame } from "./desktop-native-frame"

export class NativeCaptureHost {
  private process: ChildProcess | undefined
  private parser: NativeFrameParser | undefined
  private frame: (NativeFrame & { receivedAt: number }) | undefined
  private generation = 0

  constructor(
    private readonly binary: string,
    private readonly failed: (error: Error) => void,
    private readonly args: string[] = [],
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
          if (result.type === "error") throw new Error(`Native desktop capture stopped: ${result.code}`)
          this.frame?.data.fill(0)
          this.frame = { ...result.frame, receivedAt: performance.now() }
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
        this.fail(new Error(`Native desktop capture exited before Stop (${code ?? "unknown"})`), generation)
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

  stop(): void {
    this.generation++
    this.parser?.clear()
    this.parser = undefined
    this.frame?.data.fill(0)
    this.frame = undefined
    this.process?.kill()
    this.process = undefined
  }

  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation) return
    this.stop()
    this.failed(error instanceof Error ? error : new Error(String(error)))
  }
}
