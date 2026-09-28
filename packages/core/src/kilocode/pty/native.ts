import { writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Proc } from "../../pty/pty"
import { which } from "../../util/which"
import { NativeProcess } from "../process-host"
import type { Identity, Lease, Proof } from "./lifecycle"
import { Context, Effect } from "effect"
import { read as receipt, text, drained, exited, type Result } from "./receipts"

export class NativePty {
  private proc?: Proc
  private identity?: Identity
  private result?: Result
  private gone = false
  private ready = false
  private ended = false
  private started = false
  private cancelled = false
  private fault?: Error
  private cancelling?: Promise<void>
  private closing?: Promise<void>
  private retired?: Promise<Result>
  private published = false
  private delivered?: () => void
  private abandoned?: () => void

  private constructor(
    readonly spec: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    private readonly lease: Lease,
    private readonly retire: (proof: Proof) => Promise<void>,
    private readonly admit: (identity: Identity) => Promise<void>,
  ) {}

  static async prepare<R>(
    input: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    lease: Lease,
    context: Context.Context<R>,
  ) {
    const capability = await NativeProcess.lifecycle()
    if (
      typeof capability !== "object" ||
      capability === null ||
      Object.keys(capability).length !== 4 ||
      !("version" in capability) ||
      capability.version !== 1 ||
      !("operation" in capability) ||
      capability.operation !== "pty-lifecycle" ||
      !("proof" in capability) ||
      capability.proof !== "windows-job" ||
      !("targetExit" in capability) ||
      capability.targetExit !== true
    )
      throw new Error("Native PTY lifecycle capability unavailable")
    const controller = await NativeProcess.inspect(process.pid)
    if (
      typeof controller !== "object" ||
      controller === null ||
      !("status" in controller) ||
      controller.status !== "owned" ||
      !("birth" in controller) ||
      typeof controller.birth !== "string"
    )
      throw new Error("Native PTY controller identity unavailable")
    const command = path.isAbsolute(input.command) ? input.command : which(input.command, input.env)
    if (!command) throw new Error("Native PTY executable unavailable")
    const spec = await NativeProcess.prepare({
      ...input,
      command,
      controller: process.pid,
      birth: controller.birth,
      control: lease.control,
      token: lease.token,
    })
    const run = Effect.runPromiseWith(context)
    return new NativePty(
      spec,
      lease,
      (proof) => run(lease.retire(proof)),
      (identity) => run(lease.admit(identity)),
    )
  }

  bind(proc: Proc) {
    if (this.proc) throw new Error("Native PTY already bound")
    this.proc = proc
  }

  get writable() {
    return this.ready && !this.gone && !this.closing && !this.cancelled
  }

  get outcome() {
    return this.result?.outcome
  }

  deliver(callback: () => void) {
    if (this.abandoned) return
    if (this.published) {
      callback()
      return
    }
    this.delivered = callback
  }

  publish() {
    this.published = true
    this.delivered?.()
    this.delivered = undefined
  }

  abandon(callback: () => void) {
    this.abandoned = callback
    this.delivered = undefined
    void this.cancel().catch(() => {
      this.fault = new Error("Native PTY cancellation unknown")
    })
    if (this.ended) callback()
  }

  exit() {
    this.gone = true
    this.ready = false
  }

  private current(deadline: number) {
    return !this.gone && !this.closing && !this.ended && !this.cancelled && performance.now() < deadline
  }

  async start(signal?: AbortSignal) {
    if (this.started) throw new Error("Native PTY launch already attempted")
    this.started = true
    const abort = () => {
      this.cancelled = true
      this.ready = false
      void this.cancel().catch(() => {
        this.fault = new Error("Native PTY cancellation unknown")
      })
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try {
      if (this.fault) throw this.fault
      const deadline = performance.now() + 60000
      while (!(await receipt(`${this.lease.control}.launch`))) {
        if (!this.current(deadline)) throw new Error("Native PTY suspension unknown")
        await sleep(10)
      }
      const identity = await NativeProcess.suspended(this.lease.control, this.lease.token)
      if (identity.helper !== this.proc?.pid) throw new Error("Native PTY helper identity changed")
      if (!this.current(deadline)) throw new Error("Native PTY admission expired")
      this.identity = identity
      await this.admit(identity)
      if (!this.current(deadline)) throw new Error("Native PTY admission expired")
      await NativeProcess.resume(this.lease.control, this.lease.token, identity)
      while (true) {
        const value = await receipt(`${this.lease.control}.running`)
        if (!this.current(deadline)) {
          if (this.gone && !this.cancelled && !this.closing && performance.now() < deadline) {
            const proof = await receipt(`${this.lease.control}.drained`)
            const result = await this.evidence()
            if (drained(proof, this.lease.token) && result.outcome !== "unknown") return identity
          }
          throw new Error("Native PTY resume outcome unknown")
        }
        if (value !== undefined) {
          if (
            typeof value !== "object" ||
            value === null ||
            Object.keys(value).length !== 6 ||
            !("version" in value) ||
            value.version !== 1 ||
            !("token" in value) ||
            value.token !== this.lease.token ||
            !("proof" in value) ||
            value.proof !== "windows-job" ||
            !("pid" in value) ||
            value.pid !== identity.pid ||
            !("birth" in value) ||
            value.birth !== identity.birth ||
            !("state" in value) ||
            value.state !== "running"
          )
            throw new Error("Native PTY running identity changed")
          this.ready = true
          return identity
        }
        await sleep(10)
      }
    } catch (err) {
      await this.cancel().catch(() => {
        this.fault = new Error("Native PTY cancellation unknown")
      })
      throw err
    } finally {
      signal?.removeEventListener("abort", abort)
    }
  }

  cancel(): Promise<void> {
    this.cancelled = true
    this.ready = false
    if (this.gone) return Promise.resolve()
    if (this.cancelling) return this.cancelling
    this.cancelling = (async () => {
      await writeFile(this.lease.control, "stop", { flag: "wx", mode: 0o600 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err
      })
      if ((await text(this.lease.control)) !== "stop") throw new Error("Native PTY stop authority changed")
    })()
    return this.cancelling
  }

  finish() {
    if (this.retired) return this.retired
    const task = (async () => {
      if (!this.gone) throw new Error("Native PTY helper has not exited")
      const proof = await receipt(`${this.lease.control}.drained`)
      if (!drained(proof, this.lease.token)) throw new Error("Native PTY tree drain unknown")
      const result = await this.evidence()
      await this.retire(proof)
      this.result = result
      this.ended = true
      this.abandoned?.()
      return result
    })()
    this.retired = task
    void task.catch(() => {
      if (this.retired === task) this.retired = undefined
    })
    return task
  }

  private async evidence() {
    const identity =
      this.identity ?? (await NativeProcess.suspended(this.lease.control, this.lease.token).catch(() => undefined))
    const value = await receipt(`${this.lease.control}.exited`).catch(() => undefined)
    return exited(value, this.lease.token, identity?.helper === this.proc?.pid ? identity : undefined)
  }

  stop() {
    if (this.ended) return Promise.resolve()
    if (this.closing) return this.closing
    const task = (async () => {
      await this.cancel()
      const deadline = performance.now() + 70000
      while (!this.gone) {
        if (performance.now() >= deadline) throw new Error("Native PTY stop outcome unknown")
        await sleep(10)
      }
      await this.finish()
    })()
    this.closing = task
    void task.catch(() => {
      if (this.closing === task) this.closing = undefined
    })
    return task
  }
}
