import { BrainClient, Failure } from "./client"
import type { BrainState, BrainProposalCommand, BrainProposalResult } from "../shared/second-brain"
import { ClientV2 } from "./client-v2"
import type { BrainSettings } from "./settings"
import { join } from "./join"
import { OperationOwner } from "./operation-owner"
import { ManagedOwner } from "./managed/owner"

const empty: BrainState = Object.freeze({ configured: false, status: "disconnected", results: [] })

/** Host-private, explicit operations only. Aborted transport is not physical worker retirement. */
export class BrainService {
  private state: BrainState = empty
  private current: AbortController | undefined
  private readonly pending = new Set<Promise<void>>()
  private closed = false
  private owner: object | undefined
  private changing: Promise<void> | undefined
  private operation: OperationOwner | undefined
  private managed: ManagedOwner | undefined
  private opening: Promise<void> | undefined

  constructor(
    private readonly settings: BrainSettings,
    private readonly extension?: string,
  ) {}

  async status(): Promise<BrainState> {
    if (this.settings.pending())
      return {
        configured: this.settings.version() !== undefined,
        status: "unavailable",
        code: "control_uncertain",
        results: [],
      }
    const cfg = await this.settings.load()
    return { ...this.state, configured: !!cfg, results: [] }
  }

  async proposal(body: BrainProposalCommand, parent?: AbortSignal): Promise<BrainProposalResult> {
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000)
    const result: { value?: BrainProposalResult } = {}
    await this.configure(async () => {
      const cfg = await this.prepare(signal)
      if (!cfg || cfg.setup.version !== 2) throw new Error("Reviewed v2 Memory setup required")
      const client = new ClientV2(cfg.key, cfg.setup)
      result.value = await client.proposal(body, signal)
      if (this.managed && !this.managed.valid()) throw new Error("Original managed generation is unavailable")
    }, false)
    if (!result.value) throw new Error("Proposal publication was not observed")
    return result.value
  }

  async stop(owner?: object) {
    if (owner && owner !== this.owner) return
    this.current?.abort()
    await join([...this.pending, ...(this.operation ? [this.operation.settle()] : [])])
  }

  configure(body: () => Promise<void>, retire = true): Promise<void> {
    if (this.closed || this.changing)
      return Promise.reject(new Failure("setup_changing", "Memory setup is unavailable", 0))
    this.current?.abort()
    this.current = undefined
    this.owner = undefined
    this.state = { configured: this.state.configured, status: "disconnected", results: [] }
    const job = (async () => {
      const errors: unknown[] = []
      await this.stop().catch((err: unknown) => errors.push(err))
      if (retire) {
        await this.operation?.dispose().catch((err: unknown) => errors.push(err))
        await this.managed?.close().catch((err: unknown) => errors.push(err))
        await join(errors.map((err) => Promise.reject(err)))
        this.operation = undefined
        this.managed = undefined
        this.opening = undefined
      }
      await join(errors.map((err) => Promise.reject(err)))
      if (this.closed) throw new Failure("setup_changing", "Memory coordinator is closed", 0)
      await body()
      const cfg = await this.settings.load()
      this.state = { configured: !!cfg, status: "disconnected", results: [] }
    })().finally(() => {
      this.changing = undefined
    })
    this.changing = job
    return job
  }

  async disconnect() {
    await this.configure(() => this.settings.clear())
  }

  async dispose() {
    this.closed = true
    const errors: unknown[] = []
    await join([
      this.stop(),
      ...(this.operation ? [this.operation.dispose()] : []),
      ...(this.changing ? [this.changing] : []),
    ]).catch((err: unknown) => errors.push(err))
    await this.managed?.close().catch((err: unknown) => errors.push(err))
    await join(errors.map((err) => Promise.reject(err)))
  }

  /** Only the native control transaction may enter while configuration intake is fenced. */
  async sync(expected: string, signal: AbortSignal, close: () => Promise<void>) {
    if (this.closed || !this.changing) throw new Error("Native Memory transaction required")
    const cfg = await this.prepare(signal)
    signal.throwIfAborted()
    if (!cfg || cfg.setup.version !== 2) throw new Error("Explicit v2 Memory setup required")
    this.operation ??= new OperationOwner(this.settings, cfg.key, cfg.setup)
    const original = this.operation
    try {
      await original.sync(expected, { id: crypto.randomUUID().replaceAll("-", ""), signal, close })
    } catch (err) {
      await this.release(original, err)
      throw err
    }
  }

  run(query: string | undefined, post: (state: BrainState) => void, owner?: object): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Memory coordinator is closed"))
    if (this.changing) return Promise.reject(new Failure("setup_changing", "Memory setup is changing", 0))
    if (this.settings.version() === 2 && this.pending.size)
      return Promise.reject(new Failure("control_busy", "Original Memory operation is still settling", 0))
    if (this.settings.pending())
      return Promise.reject(new Failure("control_uncertain", "Memory publication requires reconciliation", 0))
    const signal = new AbortController()
    this.current?.abort()
    this.current = signal
    this.owner = owner
    const send = (state: BrainState) => {
      if (this.current !== signal || this.closed) return
      this.state = Object.freeze(state)
      post(this.state)
    }
    const job = this.work(query, signal.signal, send)
      .catch((err: unknown) => {
        if (this.settings.version() === 2) throw err
        if (this.operation) return
        send({
          configured: this.state.configured,
          status: signal.signal.aborted ? "cancelled" : "unavailable",
          code: signal.signal.aborted ? undefined : "setup_invalid",
          results: [],
        })
      })
      .finally(() => this.pending.delete(job))
    this.pending.add(job)
    return job
  }

  private async work(query: string | undefined, signal: AbortSignal, post: (state: BrainState) => void) {
    const cfg = await this.prepare(signal)
    signal.throwIfAborted()
    if (!cfg) {
      post(empty)
      return
    }
    post({ configured: true, status: query === undefined ? "checking" : "searching", results: [] })
    if (cfg.setup.version === 2) {
      this.operation ??= new OperationOwner(this.settings, cfg.key, cfg.setup)
      const original = this.operation
      try {
        if (query === undefined) {
          await this.operation.health(signal)
          signal.throwIfAborted()
          post({ configured: true, status: "ready", results: [] })
          return
        }
        const result = await this.operation.search(query, { id: crypto.randomUUID().replaceAll("-", ""), signal })
        signal.throwIfAborted()
        post({ configured: true, status: "ready", results: result.results })
      } catch (err) {
        await this.failure(original, err, signal, post)
        throw err
      }
      return
    }
    const client = new BrainClient(cfg.key, cfg.setup)
    try {
      if (query === undefined) {
        await client.health(signal)
        post({ configured: true, status: "ready", results: [] })
        return
      }
      const result = await client.search(query, { signal })
      post({ configured: true, status: "ready", results: result.results })
    } catch (err) {
      const health =
        query === undefined
          ? undefined
          : await client.health().then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            )
      const failure = health && !health.ok ? health.error : err
      const code = failure instanceof Failure ? failure.code : "transport_error"
      const cancelled = signal.aborted && (query === undefined || health?.ok === true)
      post({
        configured: true,
        status: cancelled ? "cancelled" : "unavailable",
        code: cancelled ? undefined : code,
        results: [],
      })
    }
  }
  private async prepare(signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.opening ??= (async () => {
      const cfg = await this.settings.load()
      if (!cfg?.managed) return
      if (!this.managed) {
        if (!this.extension) throw new Error("Packaged native managed host required")
        this.managed = new ManagedOwner(
          cfg.managed,
          cfg.setup,
          this.extension,
          this.settings.managed(cfg.setup),
          cfg.launch,
        )
        await this.managed.open(signal)
      }
      if (!this.managed.valid()) throw new Error("Original managed generation is unavailable")
    })().finally(() => {
      if (!this.managed) this.opening = undefined
    })
    await this.opening
    signal?.throwIfAborted()
    if (this.managed && !this.managed.valid()) throw new Error("Original managed generation is unavailable")
    return this.settings.load()
  }
  private async failure(
    original: OperationOwner,
    err: unknown,
    signal: AbortSignal,
    post: (state: BrainState) => void,
  ) {
    await this.release(original, err)
    post({
      configured: true,
      status: original.retired() && signal.aborted ? "cancelled" : "unavailable",
      code: this.settings.pending() ? "control_uncertain" : err instanceof Failure ? err.code : "transport_error",
      results: [],
    })
  }

  private async release(original: OperationOwner, err: unknown) {
    if (original.retired()) {
      // Disposal still rejects the original cancelled outcome; only that exact failure may release this generation.
      const closed = await original.dispose().then(
        () => undefined,
        (failure: unknown) => failure,
      )
      if (closed !== undefined && closed !== err)
        throw new AggregateError([err, closed], "Original Memory generation cleanup failed")
      if (this.operation === original) this.operation = undefined
    }
  }
}
