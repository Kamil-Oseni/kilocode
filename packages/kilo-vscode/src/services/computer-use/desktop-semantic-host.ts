import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { spawn } from "../../util/process"
import { DesktopCaptureClock } from "./desktop-capture-clock"
import { clock, encode, parse, type Request, type Reply } from "./desktop-semantic-protocol"

type Pending = {
  request: Request
  started: number
  sent?: number
  bytes: number
  calibration?: string
  timer: ReturnType<typeof setTimeout>
  resolve(value: Extract<Reply, { semantics: unknown }> & { age: number }): void
  reject(error: Error): void
}

/** The provider runs outside the input/capture lifetimes. Retired reads never replay. */
export class NativeSemanticHost {
  private child: ChildProcess | undefined
  private pending: Pending | undefined
  private generation = 1
  private retiring: { child: ChildProcess; done: Promise<boolean> } | undefined
  private starting: Promise<ChildProcess> | undefined
  private readiness: { resolve(child: ChildProcess): void; reject(error: Error): void } | undefined
  private buffer = Buffer.alloc(0)
  private readonly clock = new DesktopCaptureClock()

  constructor(
    private readonly binary: string,
    private readonly timeout = 15_000,
    private readonly args: string[] = ["--serve-v1"],
  ) {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000)
      throw new Error("Desktop semantic deadline is invalid")
  }

  read(target: Pick<Request, "windowID" | "identity" | "location">) {
    if (this.pending) return Promise.reject(new Error("A desktop semantic read is already active"))
    const request = { ...target, request: randomBytes(16).toString("hex"), generation: this.generation }
    const data = encode(request)
    const started = performance.now()
    return new Promise<Extract<Reply, { semantics: unknown }> & { age: number }>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Desktop semantic read timed out")), this.timeout)
      const pending: Pending = { request, started, bytes: 0, timer, resolve, reject }
      this.pending = pending
      Promise.resolve().then(async () => {
        if (this.retiring) await this.retiring.done
        if (this.pending !== pending) {
          data.fill(0)
          return
        }
        if (performance.now() - started >= this.timeout) {
          data.fill(0)
          this.fail(new Error("Desktop semantic read timed out"))
          return
        }
        try {
          if (this.retiring) throw new Error("Desktop semantic worker has not stopped")
          const child = await this.start()
          if (this.pending !== pending) {
            data.fill(0)
            return
          }
          if (performance.now() - started >= this.timeout) throw new Error("Desktop semantic read timed out")
          if (!child.stdin?.writable) throw new Error("Desktop semantic input pipe is unavailable")
          pending.sent = performance.now()
          child.stdin.write(data, (error) => {
            data.fill(0)
            if (error && this.pending === pending) this.fail(new Error("Desktop semantic request delivery failed"))
          })
        } catch (error) {
          data.fill(0)
          if (this.pending === pending)
            this.fail(error instanceof Error ? error : new Error("Desktop semantic worker could not start"))
        }
      })
    })
  }

  cancel(): void {
    this.fail(new Error("Desktop semantic read was cancelled"))
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return this.starting ?? Promise.resolve(this.child)
    const generation = this.generation
    const child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", "ignore"] })
    this.child = child
    const readiness = new Promise<ChildProcess>((resolve, reject) => {
      this.readiness = { resolve, reject }
    })
    this.starting = readiness
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== child || generation !== this.generation) return
      try {
        this.accept(chunk)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Desktop semantic response is invalid"))
      }
    })
    child.stdin?.on("error", () => {
      if (this.child === child) this.fail(new Error("Desktop semantic request pipe closed"))
    })
    child.on("error", () => {
      if (this.child === child) this.fail(new Error("Desktop semantic worker failed"))
    })
    child.on("close", () => {
      if (this.child === child) {
        this.child = undefined
        this.fail(new Error("Desktop semantic worker exited"))
      }
    })
    return readiness
  }

  private accept(chunk: Buffer): void {
    const pending = this.pending
    if (!pending) throw new Error("Desktop semantic response has no active request")
    pending.bytes += chunk.length
    if (pending.bytes > 1_048_576 + 256) throw new Error("Desktop semantic response exceeds its limit")
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length) {
      const end = this.buffer.indexOf(10)
      if (end < 0) {
        if (this.buffer.length > 1_048_576) throw new Error("Desktop semantic response exceeds its limit")
        return
      }
      const line = this.buffer.subarray(0, end)
      this.buffer = this.buffer.subarray(end + 1)
      if (!line.length || line.length > 1_048_576) throw new Error("Desktop semantic response is invalid")
      if (this.readiness) {
        if (!line.equals(Buffer.from('{"version":1,"type":"ready"}', "ascii")) || this.buffer.length)
          throw new Error("Desktop semantic readiness response is invalid")
        const readiness = this.readiness
        this.readiness = undefined
        this.starting = undefined
        readiness.resolve(this.child!)
        continue
      }
      if (this.pending !== pending) throw new Error("Desktop semantic response has no active request")
      if (performance.now() - pending.started >= this.timeout) throw new Error("Desktop semantic read timed out")
      if (!pending.calibration) {
        const stamp = this.calibration(line, pending.request)
        if (pending.sent === undefined) throw new Error("Desktop semantic request was not dispatched")
        this.clock.calibrate(stamp.qpc, stamp.frequency, pending.sent, performance.now())
        pending.calibration = stamp.qpc
        continue
      }
      const result = parse(line, pending.request)
      if ("type" in result) throw new Error(`Desktop semantic observation refused: ${result.code}`)
      this.complete(pending, result)
    }
  }

  private calibration(line: Buffer, request: Request) {
    try {
      return clock(line, request)
    } catch (error) {
      const reply = parse(line, request)
      if ("type" in reply) throw new Error(`Desktop semantic observation refused: ${reply.code}`)
      throw error
    }
  }

  private complete(pending: Pending, result: Extract<Reply, { semantics: unknown }>): void {
    if (BigInt(result.clock.acquisition) < BigInt(pending.calibration!))
      throw new Error("Desktop semantic acquisition predates its request")
    const now = performance.now()
    if (now - pending.started >= this.timeout) throw new Error("Desktop semantic read timed out")
    const age = this.clock.bounds(result.clock, now)
    if (!age || age.upper > 125) throw new Error("Desktop semantic observation is stale")
    if (this.buffer.length) throw new Error("Desktop semantic response contains trailing data")
    clearTimeout(pending.timer)
    this.pending = undefined
    this.clock.clear()
    pending.resolve({ ...result, age: age.upper })
  }

  private fail(error: Error): void {
    this.generation += 1
    const pending = this.pending
    const child = this.child
    const readiness = this.readiness
    this.readiness = undefined
    this.starting = undefined
    this.pending = undefined
    this.child = undefined
    this.buffer.fill(0)
    this.buffer = Buffer.alloc(0)
    this.clock.clear()
    readiness?.reject(error)
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    if (child) {
      const done = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1_000)
        child.once("close", () => {
          clearTimeout(timer)
          if (this.retiring?.child === child) this.retiring = undefined
          resolve(true)
        })
      })
      this.retiring = { child, done }
      child.kill()
    }
  }
}
