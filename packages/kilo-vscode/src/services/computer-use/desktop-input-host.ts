import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import type { DesktopAction, DesktopDispatchTarget } from "./desktop-session"
import { input, resolve } from "./desktop-input-action"

type Kind = "hello" | "dispatch" | "cancel" | "quiescent"
type Status = "ready" | "refused" | "cancelled" | "quiescent" | "confirmed" | "unknown"
type Reply = {
  v: 2
  type: Status
  session: string
  request: string
  sequence: number
  code: string
  accepted: number
  attempted: number
}

export class NativeInputPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NativeInputPreflightError"
  }
}

const hex = /^[a-f0-9]{32}$/
const codes = new Set([
  "ok",
  "bad_frame",
  "bad_version",
  "bad_session",
  "bad_nonce",
  "duplicate",
  "stale",
  "bad_target",
  "changed_target",
  "unsupported",
  "cancelled",
  "input_failed",
  "partial",
  "unknown",
  "expired",
  "input_busy",
  "in_flight",
])

function frame(value: object, payload: Buffer = Buffer.alloc(0)): Buffer {
  const data = Buffer.from(JSON.stringify(value), "utf8")
  if (data.length > 4096) throw new Error("Native input request exceeds the protocol bound")
  if (payload.length > 512) throw new Error("Native input payload exceeds the protocol bound")
  const packet = Buffer.alloc(8 + data.length + payload.length)
  packet.writeUInt32LE(data.length, 0)
  data.copy(packet, 4)
  packet.writeUInt32LE(payload.length, 4 + data.length)
  payload.copy(packet, 8 + data.length)
  return packet
}

function parse(value: unknown, session: string): Reply {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native input broker returned a malformed reply")
  const reply = value as Record<string, unknown>
  if (
    Object.keys(reply).length !== 8 ||
    reply.v !== 2 ||
    !["ready", "refused", "cancelled", "quiescent", "confirmed", "unknown"].includes(String(reply.type)) ||
    reply.session !== session ||
    typeof reply.request !== "string" ||
    !hex.test(reply.request) ||
    !Number.isSafeInteger(reply.sequence) ||
    typeof reply.code !== "string" ||
    !codes.has(reply.code) ||
    !Number.isSafeInteger(reply.accepted) ||
    !Number.isSafeInteger(reply.attempted) ||
    (reply.accepted as number) < 0 ||
    (reply.attempted as number) < 0 ||
    (reply.accepted as number) > (reply.attempted as number)
  )
    throw new Error("Native input broker returned a malformed reply")
  return reply as Reply
}

export class NativeInputHost {
  private readonly session = randomBytes(16).toString("hex")
  private readonly nonce = randomBytes(16).toString("hex")
  private readonly pending = new Map<
    string,
    {
      kind: Kind
      sequence: number
      resolve: (reply: Reply) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = Buffer.alloc(0)
  private sequence = 0
  private stopping: Promise<void> | undefined
  private hello: Promise<Reply> | undefined
  private dispatching: Promise<Reply> | undefined
  private state: "new" | "starting" | "ready" | "blocked" | "closed" = "new"
  private uncertain = false
  private quiescent = false

  get canClose(): boolean {
    return this.state === "blocked" && this.quiescent && !this.uncertain && this.pending.size === 0
  }

  constructor(
    private readonly binary: string,
    private readonly args: string[] = [],
    private readonly timeout = 5_000,
  ) {}

  async start(): Promise<void> {
    if (this.state !== "new") throw new NativeInputPreflightError("Native input broker cannot restart a session")
    this.state = "starting"
    const child = spawn(this.binary, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk))
    child.on("error", (error) => this.fail(error))
    child.on("close", () => this.fail(new Error("Native input broker exited; action outcome is unknown"), true))
    const pending = this.send("hello", 0)
    this.hello = pending
    const reply = await pending
    if (reply.type !== "ready" || reply.code !== "ok") {
      this.fail(new Error(`Native input broker refused its session (${reply.code})`))
      throw new Error(`Native input broker refused its session (${reply.code})`)
    }
    if (this.state !== "starting") throw new NativeInputPreflightError("Native input broker startup was cancelled")
    this.state = "ready"
  }

  async dispatch(action: DesktopAction, value: DesktopDispatchTarget): Promise<Reply> {
    if (this.state !== "ready") throw new NativeInputPreflightError("Native input broker is not ready")
    if (this.pending.size) throw new NativeInputPreflightError("Native input broker already has a request in flight")
    const pending = (() => {
      try {
        const detail = resolve(value)
        const effect = input(action)
        if (action.windowID.toLowerCase() !== value.windowID.toLowerCase())
          throw new Error("Native input action and target differ")
        return this.send("dispatch", undefined, { ...detail, ...effect }, effect.payload)
      } catch (error) {
        throw new NativeInputPreflightError(error instanceof Error ? error.message : String(error))
      }
    })()
    this.dispatching = pending
    const reply = await pending.finally(() => {
      if (this.dispatching === pending) this.dispatching = undefined
    })
    if (reply.type === "unknown" || reply.code === "partial") {
      this.uncertain = true
      this.state = "blocked"
    }
    return reply
  }

  async cancel(): Promise<void> {
    if (this.state === "closed") return
    if (this.stopping) return this.stopping
    if (this.state === "new") {
      this.state = "blocked"
      this.quiescent = true
      this.stopping = Promise.resolve()
      return this.stopping
    }
    this.state = "blocked"
    this.stopping = (async () => {
      if (this.hello) await this.hello
      const cancelled = await this.send("cancel")
      if (cancelled.type !== "cancelled" || !["ok", "in_flight"].includes(cancelled.code))
        throw new Error("Native input broker did not acknowledge cancellation")
      const settled = await this.send("quiescent")
      if (settled.type !== "quiescent" || settled.code !== "ok")
        throw new Error("Native input broker did not prove quiescence")
      this.quiescent = true
      const pending = this.dispatching
      if (pending) await pending
      if (this.uncertain || this.pending.size)
        throw new Error("Native input broker action outcome is unknown after quiescence")
    })()
    return this.stopping
  }

  close(): void {
    if (!this.canClose) throw new Error("Native input broker cannot close without a settled, certain quiescent session")
    this.state = "closed"
    this.child?.kill()
    this.child = undefined
    this.buffer.fill(0)
    this.buffer = Buffer.alloc(0)
  }

  private send(kind: Kind, sequence?: number, detail?: Record<string, unknown>, payload?: Buffer) {
    const child = this.child
    if (!child || this.state === "closed") return Promise.reject(new Error("Native input broker is stopped"))
    const request = randomBytes(16).toString("hex")
    const next = sequence ?? ++this.sequence
    const header = {
      v: 2,
      type: kind,
      session: this.session,
      request,
      sequence: next,
      nonce: this.nonce,
      windowID: detail?.windowID ?? "0",
      pid: detail?.pid ?? 0,
      scene: detail?.scene ?? 0,
      ...(kind === "dispatch" ? this.fields(detail) : {}),
    }
    const packet = frame(header, payload)
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (kind === "dispatch") {
          this.state = "blocked"
          this.uncertain = true
          reject(new Error("Native input broker response timed out; action outcome is unknown"))
          return
        }
        this.fail(new Error("Native input broker response timed out"))
      }, this.timeout)
      this.pending.set(request, { kind, sequence: next, resolve, reject, timer })
      child.stdin.write(packet, (error) => {
        if (error) this.fail(error)
      })
    })
  }

  private fields(detail?: Record<string, unknown>) {
    return {
      identity: detail?.identity,
      left: detail?.left,
      top: detail?.top,
      right: detail?.right,
      bottom: detail?.bottom,
      action: detail?.action,
      a: detail?.a,
      b: detail?.b,
      c: detail?.c,
      d: detail?.d,
      e: detail?.e,
      observedAt: detail?.observedAt,
      validUntil: detail?.validUntil,
    }
  }

  private read(chunk: Buffer): void {
    if (this.state === "closed") return
    if (chunk.length > 16_384 - this.buffer.length)
      return this.fail(new Error("Native input broker output exceeds its bound"))
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt32LE(0)
      if (!size || size > 4096) return this.fail(new Error("Native input broker response has an invalid length"))
      if (this.buffer.length < size + 8) return
      if (this.buffer.readUInt32LE(size + 4) !== 0)
        return this.fail(new Error("Native input broker unexpectedly returned a payload"))
      const body = this.buffer.subarray(4, size + 4)
      this.buffer = this.buffer.subarray(size + 8)
      try {
        const reply = parse(JSON.parse(body.toString("utf8")), this.session)
        const pending = this.pending.get(reply.request)
        if (!pending || pending.sequence !== reply.sequence)
          throw new Error("Native input broker returned an unbound or stale reply")
        clearTimeout(pending.timer)
        this.pending.delete(reply.request)
        if (pending.kind === "dispatch" && (reply.type === "unknown" || reply.code === "partial")) {
          this.state = "blocked"
          this.uncertain = true
        }
        pending.resolve(reply)
      } catch (error) {
        return this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private fail(error: Error, exited = false): void {
    if (this.state === "closed") return
    const active = [...this.pending.values()].some((pending) => pending.kind === "dispatch")
    this.state = active && !exited ? "blocked" : "closed"
    if (active) this.uncertain = true
    if (!active || exited) {
      if (!exited) this.child?.kill()
      this.child = undefined
    }
    this.buffer.fill(0)
    this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
