import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"

type Kind = "hello" | "dispatch" | "cancel" | "quiescent"
type Status = "ready" | "refused" | "cancelled" | "quiescent"
type Reply = {
  v: 1
  type: Status
  session: string
  request: string
  sequence: number
  code: string
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
])

function frame(value: object): Buffer {
  const data = Buffer.from(JSON.stringify(value), "utf8")
  if (data.length > 4096) throw new Error("Native input request exceeds the protocol bound")
  const packet = Buffer.alloc(8 + data.length)
  packet.writeUInt32LE(data.length, 0)
  data.copy(packet, 4)
  packet.writeUInt32LE(0, 4 + data.length)
  return packet
}

function parse(value: unknown, session: string): Reply {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native input broker returned a malformed reply")
  const reply = value as Record<string, unknown>
  if (
    Object.keys(reply).length !== 6 ||
    reply.v !== 1 ||
    !["ready", "refused", "cancelled", "quiescent"].includes(String(reply.type)) ||
    reply.session !== session ||
    typeof reply.request !== "string" ||
    !hex.test(reply.request) ||
    !Number.isSafeInteger(reply.sequence) ||
    typeof reply.code !== "string" ||
    !codes.has(reply.code)
  )
    throw new Error("Native input broker returned a malformed reply")
  return reply as Reply
}

export class NativeInputHost {
  private readonly session = randomBytes(16).toString("hex")
  private readonly nonce = randomBytes(16).toString("hex")
  private readonly pending = new Map<
    string,
    { sequence: number; resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = Buffer.alloc(0)
  private sequence = 0
  private stopping: Promise<void> | undefined
  private state: "new" | "ready" | "blocked" | "closed" = "new"

  constructor(
    private readonly binary: string,
    private readonly args: string[] = [],
  ) {}

  async start(): Promise<void> {
    if (this.state !== "new") throw new Error("Native input broker cannot restart a session")
    const child = spawn(this.binary, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk))
    child.on("error", (error) => this.fail(error))
    child.on("close", () => this.fail(new Error("Native input broker exited; action outcome is unknown")))
    const reply = await this.send("hello", 0)
    if (reply.type !== "ready" || reply.code !== "ok") {
      this.fail(new Error(`Native input broker refused its session (${reply.code})`))
      throw new Error(`Native input broker refused its session (${reply.code})`)
    }
    this.state = "ready"
  }

  async probe(target: { windowID: string; pid: number; scene: number }): Promise<Reply> {
    if (this.state !== "ready") throw new Error("Native input broker is not ready")
    if (this.pending.size) throw new Error("Native input broker already has a request in flight")
    if (
      !/^0x[0-9a-fA-F]+$/.test(target.windowID) ||
      !Number.isSafeInteger(target.pid) ||
      target.pid <= 0 ||
      target.pid > 0xffffffff ||
      !Number.isSafeInteger(target.scene) ||
      target.scene <= 0
    )
      throw new Error("Native input target identity is invalid")
    return this.send("dispatch", undefined, {
      windowID: target.windowID.slice(2).toLowerCase(),
      pid: target.pid,
      scene: target.scene,
    })
  }

  async cancel(): Promise<void> {
    if (this.state === "closed" || this.state === "new") return
    if (this.stopping) return this.stopping
    this.state = "blocked"
    this.stopping = (async () => {
      const cancelled = await this.send("cancel")
      if (cancelled.type !== "cancelled" || cancelled.code !== "ok")
        throw new Error("Native input broker did not acknowledge cancellation")
      const settled = await this.send("quiescent")
      if (settled.type !== "quiescent" || settled.code !== "ok")
        throw new Error("Native input broker did not prove quiescence")
    })()
    return this.stopping
  }

  close(): void {
    if (this.state === "ready") throw new Error("Native input broker must be cancelled before close")
    if (this.pending.size) throw new Error("Cannot close a native input broker with an unsettled request")
    this.state = "closed"
    this.child?.kill()
    this.child = undefined
    this.buffer.fill(0)
    this.buffer = Buffer.alloc(0)
  }

  private send(kind: Kind, sequence?: number, target?: { windowID: string; pid: number; scene: number }) {
    const child = this.child
    if (!child || this.state === "closed") return Promise.reject(new Error("Native input broker is stopped"))
    const request = randomBytes(16).toString("hex")
    const next = sequence ?? ++this.sequence
    const packet = frame({
      v: 1,
      type: kind,
      session: this.session,
      request,
      sequence: next,
      nonce: this.nonce,
      windowID: target?.windowID ?? "0",
      pid: target?.pid ?? 0,
      scene: target?.scene ?? 0,
    })
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Native input broker response timed out")), 5_000)
      this.pending.set(request, { sequence: next, resolve, reject, timer })
      child.stdin.write(packet, (error) => {
        if (error) this.fail(error)
      })
    })
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
        pending.resolve(reply)
      } catch (error) {
        return this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private fail(error: Error): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.child?.kill()
    this.child = undefined
    this.buffer.fill(0)
    this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
