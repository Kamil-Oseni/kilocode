import { BrainClient, Failure } from "./client"
import type { BrainState, BrainContext, BrainProposalCommand, BrainProposalResult } from "../shared/second-brain"
import { ClientV2 } from "./client-v2"
import type { BrainSettings } from "./settings"
import { join } from "./join"
import { OperationOwner } from "./operation-owner"
import { ManagedOwner } from "./managed/owner"
import type { CaptureBinding, CapturePublication } from "./capture-intake"

import { setup as file } from "../shared/memory-query"

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
  private captures = new WeakMap<CaptureBinding, NonNullable<Awaited<ReturnType<BrainSettings["load"]>>>["setup"]>()

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
    return { ...this.state, configured: !!cfg, results: [], root: cfg?.setup.root }
  }

  async proposal(
    body: BrainProposalCommand,
    parent?: AbortSignal,
    authorize?: (root: string, signal: AbortSignal) => Promise<void>,
  ): Promise<BrainProposalResult> {
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000)
    const result: { value?: BrainProposalResult } = {}
    await this.configure(async () => {
      const cfg = await this.prepare(signal)
      if (!cfg || cfg.setup.version !== 2) throw new Error("Reviewed v2 Memory setup required")
      await authorize?.(cfg.setup.root, signal)
      const client = new ClientV2(cfg.key, cfg.setup)
      result.value = await client.proposal(body, signal)
      await authorize?.(cfg.setup.root, signal)
      if (this.managed && !this.managed.valid()) throw new Error("Original managed generation is unavailable")
    }, false)
    if (!result.value) throw new Error("Proposal publication was not observed")
    return result.value
  }

  async context(query: string, budget: number, parent: AbortSignal): Promise<{ root: string; context: BrainContext }> {
    if (!query.trim() || query.length > 8000 || !Number.isSafeInteger(budget) || budget < 1 || budget > 12000)
      throw new Error("Supply a bounded Memory context query")
    const result: { value?: { root: string; context: BrainContext } } = {}
    await this.run(
      query,
      (state) => {
        if (state.status === "ready" && state.context && state.root)
          result.value = { root: state.root, context: state.context }
      },
      {},
      { budget, parent },
    )
    parent.throwIfAborted()
    if (!result.value) throw new Error("Memory context result was not confirmed")
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

  reconcile() {
    if (this.closed || this.changing || this.pending.size || !this.operation)
      return Promise.reject(
        new Failure("control_uncertain", "Original Memory operation is unavailable for recovery", 0),
      )
    const original = this.operation
    const job = (async () => {
      const error = await original.reconcile()
      await this.release(original, error)
      this.state = { configured: true, status: "disconnected", results: [] }
      return this.status()
    })().finally(() => {
      this.changing = undefined
    })
    this.changing = job.then(() => undefined)
    void this.changing.catch(() => undefined)
    return job
  }

  repair(file: string, confirm: Parameters<BrainSettings["repair"]>[1]) {
    return this.recovery(() => this.settings.repair(file, confirm))
  }

  archive(file: string, confirm: Parameters<BrainSettings["archive"]>[1]) {
    return this.recovery(() => this.settings.archive(file, confirm))
  }

  resume(confirm: Parameters<BrainSettings["resume"]>[0]) {
    return this.recovery(() => this.settings.resume(confirm))
  }

  private recovery(body: () => Promise<void>) {
    if (this.closed || this.changing || this.pending.size || this.operation || this.managed)
      return Promise.reject(
        new Failure("control_uncertain", "Historical repair requires a fresh host with no owned work", 0),
      )
    const job = body()
      .then(() => {
        this.opening = undefined
        this.state = { configured: true, status: "disconnected", results: [] }
      })
      .finally(() => {
        this.changing = undefined
      })
    this.changing = job
    return job
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
  async capture(body: CapturePublication, expected: string, signal: AbortSignal, close: () => Promise<void>) {
    if (this.closed || !this.changing || typeof close !== "function" || !/^[a-f0-9]{64}$/.test(expected))
      throw new Error("Original native capture transaction required")
    const cfg = await this.prepare(signal)
    signal.throwIfAborted()
    if (
      !cfg ||
      cfg.setup.version !== 2 ||
      cfg.setup.protocol !== "raya.memory.operation.v2" ||
      !("capture.py" in cfg.setup.source_sha256)
    )
      throw new Error("Reviewed capture-capable Memory setup required")
    this.operation ??= new OperationOwner(this.settings, cfg.key, cfg.setup)
    const original = this.operation
    try {
      const result = await original.capture(body, expected, { id: crypto.randomUUID().replaceAll("-", ""), signal })
      signal.throwIfAborted()
      if (this.managed && !this.managed.valid()) throw new Error("Original managed generation is unavailable")
      if (
        result.id !== body.id ||
        typeof result.input_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(result.input_sha256) ||
        result.status !== "committed"
      )
        throw new Error("Original committed capture receipt was not confirmed")
      return { ...result, id: body.id, input_sha256: result.input_sha256 }
    } catch (err) {
      await this.release(original, err)
      throw err
    }
  }

  async captureSelection(signal: AbortSignal): Promise<CaptureBinding> {
    if (this.closed || this.changing || this.pending.size || this.settings.pending())
      throw new Error("Memory capture selection is busy or uncertain")
    const cfg = await this.prepare(signal)
    if (
      !cfg ||
      cfg.setup.version !== 2 ||
      cfg.setup.protocol !== "raya.memory.operation.v2" ||
      !("capture.py" in cfg.setup.source_sha256)
    )
      throw new Error("Select the reviewed capture-capable Memory release")
    this.operation ??= new OperationOwner(this.settings, cfg.key, cfg.setup)
    const original = this.operation
    const health = await original.health(signal)
    signal.throwIfAborted()
    if (this.operation !== original || !this.settings.current(cfg.setup) || (this.managed && !this.managed.valid()))
      throw new Error("Original Memory capture generation changed")
    const binding = Object.freeze({
      root: cfg.setup.root,
      release: health.release,
      owner: health.epoch,
      generation: original,
    })
    this.captures.set(binding, cfg.setup)
    return binding
  }

  captureCurrent(binding: CaptureBinding) {
    const setup = this.captures.get(binding)
    return (
      !this.closed &&
      !!setup &&
      this.operation === binding.generation &&
      this.settings.current(setup) &&
      (!this.managed || this.managed.valid())
    )
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

  run(
    query: string | undefined,
    post: (state: BrainState) => void,
    owner?: object,
    recall?: { budget: number; parent: AbortSignal },
  ): Promise<void> {
    if (recall?.parent.aborted) return Promise.reject(recall.parent.reason)
    if (this.closed) return Promise.reject(new Error("Memory coordinator is closed"))
    if (this.changing) return Promise.reject(new Failure("setup_changing", "Memory setup is changing", 0))
    if (this.settings.version() === 2 && this.pending.size)
      return Promise.reject(new Failure("control_busy", "Original Memory operation is still settling", 0))
    if (this.settings.pending())
      return Promise.reject(new Failure("control_uncertain", "Memory publication requires reconciliation", 0))
    const signal = new AbortController()
    const abort = () => signal.abort(recall?.parent.reason)
    recall?.parent.addEventListener("abort", abort, { once: true })
    this.current?.abort()
    this.current = signal
    this.owner = owner
    const send = (state: BrainState) => {
      if (this.current !== signal || this.closed) return
      this.state = Object.freeze(state)
      post(this.state)
    }
    const job = this.work(query, signal.signal, send, recall?.budget)
      .catch((err: unknown) => {
        if (recall || this.settings.version() === 2) throw err
        if (this.operation) return
        send({
          configured: this.state.configured,
          status: signal.signal.aborted ? "cancelled" : "unavailable",
          code: signal.signal.aborted ? undefined : err instanceof Failure ? err.code : "setup_invalid",
          results: [],
        })
      })
      .finally(() => {
        recall?.parent.removeEventListener("abort", abort)
        this.pending.delete(job)
      })
    this.pending.add(job)
    return job
  }

  private async work(
    query: string | undefined,
    signal: AbortSignal,
    post: (state: BrainState) => void,
    budget?: number,
  ) {
    if (query !== undefined && file(query))
      throw new Failure("setup_file_query", "This is a file path. Choose your setup file in Memory setup.", 0)
    const cfg = await this.prepare(signal)
    signal.throwIfAborted()
    if (!cfg) {
      post(empty)
      return
    }
    if (budget !== undefined && cfg.setup.version !== 2)
      throw new Failure("unsupported", "Reviewed v2 Memory context setup required", 0)
    post({ configured: true, status: query === undefined ? "checking" : "searching", results: [] })
    if (cfg.setup.version === 2) {
      this.operation ??= new OperationOwner(this.settings, cfg.key, cfg.setup)
      const original = this.operation
      await this.search(query, budget, signal, post, cfg.setup.root, original)
      return
    }
    const client = new BrainClient(cfg.key, cfg.setup)
    try {
      if (query === undefined) {
        await client.health(signal)
        post({ configured: true, status: "ready", results: [], root: cfg.setup.root })
        return
      }
      const result = await client.search(query, { signal })
      post({ configured: true, status: "ready", results: result.results, recall: "unverified", root: cfg.setup.root })
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
  private async search(
    query: string | undefined,
    budget: number | undefined,
    signal: AbortSignal,
    post: (state: BrainState) => void,
    root: string,
    original: OperationOwner,
  ) {
    try {
      if (query === undefined) {
        const health = await original.health(signal)
        signal.throwIfAborted()
        if (this.managed && !this.managed.valid()) throw new Error("Original managed generation is unavailable")
        post({
          configured: true,
          status: "ready",
          results: [],
          root,
          ...(health.index ? { control: health.index } : {}),
        })
        return
      }
      if (budget !== undefined) {
        const context = await original.context(query, budget, { id: crypto.randomUUID().replaceAll("-", ""), signal })
        signal.throwIfAborted()
        if (this.managed && !this.managed.valid()) throw new Error("Original managed generation is unavailable")
        post({ configured: true, status: "ready", results: [], root, context })
        return
      }
      const result = await original.search(query, { id: crypto.randomUUID().replaceAll("-", ""), signal })
      signal.throwIfAborted()
      post({ configured: true, status: "ready", results: result.results, recall: "unverified", root })
    } catch (err) {
      await this.failure(original, err, signal, post)
      throw err
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
