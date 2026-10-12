import { ClientV2, type Publication } from "./client-v2"
import { Failure } from "./client"
import { object } from "./control/frames"
import { parse, type BrainSettings } from "./settings"

type Options = { id: string; signal?: AbortSignal }
type Slot = { controller: AbortController; job: Promise<unknown> }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
const outcome = <T>(job: Promise<T>): Promise<Outcome<T>> =>
  job.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )
function raise(errors: readonly unknown[]) {
  const distinct = [...new Set(errors)]
  if (distinct.length === 1) throw distinct[0]
  if (distinct.length > 1) throw new AggregateError(distinct, "Original Memory operation failures retained")
}

/** Generation-owned host boundary: one retained client and accepted slot, never restarted-worker adoption. */
export class OperationOwner {
  #client: ClientV2
  #setup: Extract<ReturnType<typeof parse>, { version: 2 }>
  #slot?: Slot
  #closed = false
  #ending?: Promise<void>
  #ids = new Set<string>()
  #failures = new Set<unknown>()
  #lease: object
  #retired = false
  #recovery?: { id: string; debt: unknown }

  constructor(
    private readonly settings: BrainSettings,
    key: string,
    input: unknown,
  ) {
    const setup = parse(input)
    if (setup.version !== 2) throw new Error("Explicit v2 operation setup required")
    this.#setup = setup
    this.#client = new ClientV2(key, setup)
    this.#lease = settings.selection(input, this.#client)
  }

  health(signal?: AbortSignal) {
    if (this.#closed || this.#slot || this.#failures.size || this.settings.pending())
      return Promise.reject(new Failure("control_uncertain", "Memory operation owner is unavailable", 0))
    return this.#client.health(signal)
  }

  search(query: string, opts: Options) {
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.length > 8000 ||
      Buffer.byteLength(JSON.stringify({ query, top: 5 })) > 16000
    )
      return Promise.reject(new Error("Supply a bounded Memory query"))
    return this.run((before, signal, id) => this.#client.search(query, { id, before, signal }), opts)
  }

  context(query: string, budget: number, opts: Options) {
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.length > 8000 ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > 12000 ||
      Buffer.byteLength(JSON.stringify({ query, top: 5, context_budget: budget })) > 16000
    )
      return Promise.reject(new Error("Supply a bounded query and explicit linked-context budget"))
    return this.run((before, signal, id) => this.#client.context(query, budget, { id, before, signal }), opts)
  }

  capture(body: Publication, expected: string, opts: Options) {
    return this.run((before, signal, id) => this.#client.capture(body, expected, { id, before, signal }), opts)
  }

  management(body: Record<string, unknown>, signal: AbortSignal, check: () => void) {
    if (this.#closed || this.#slot || this.#failures.size || this.settings.pending())
      return Promise.reject(new Failure("control_uncertain", "Original personal Memory owner is unavailable", 0))
    check()
    // Reuse the original health-bound client; never adopt a restarted service epoch.
    return this.#client.management(body, signal).then((value) => {
      check()
      return value
    })
  }

  sync(expected: string, opts: Options & { close: () => Promise<void> }) {
    if (
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      expected.length !== 64 ||
      typeof opts.close !== "function"
    )
      return Promise.reject(new Error("Confirmed policy and original local close required"))
    return this.run((before, signal, id) => this.#client.sync(expected, { id, before, signal }), opts, opts.close)
  }

  private run<T>(
    body: (before: (request: unknown) => Promise<void>, signal: AbortSignal, id: string) => Promise<T>,
    opts: Options,
    close?: () => Promise<void>,
  ) {
    if (this.#closed || this.#slot || this.#failures.size || this.settings.pending())
      return Promise.reject(new Failure("control_uncertain", "Memory operation owner is busy, closed or uncertain", 0))
    const id = opts.id
    if (
      typeof id !== "string" ||
      id.length !== 32 ||
      !/^[a-f0-9]{32}$/.test(id) ||
      this.#ids.has(id) ||
      this.#ids.size >= 256
    )
      return Promise.reject(new Error("Fresh internal Memory request required"))
    this.#ids.add(id)
    const controller = new AbortController()
    const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const job = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    const slot = { controller, job }
    // Publish the accepted lifetime synchronously, before health or durable writes.
    this.#retired = false
    this.#recovery = undefined
    this.#slot = slot
    const work = this.work(body, signal, id, close)
    void work.then(
      (value) => {
        if (this.#slot === slot) this.#slot = undefined
        resolve(value)
      },
      (error: unknown) => {
        this.#failures.add(error)
        if (this.#slot === slot) this.#slot = undefined
        reject(error)
      },
    )
    void job.catch(() => undefined)
    return job
  }

  private async inspect(id: string, cancel: boolean) {
    const errors: unknown[] = []
    if (cancel) {
      const cancelled = await outcome(this.#client.cancel(id))
      if (!cancelled.ok) errors.push(cancelled.error)
    }
    const observed = await outcome(this.#client.observe(id))
    if (!observed.ok) errors.push(observed.error)
    if (observed.ok) {
      const operation = object(observed.value.operation)
      if (operation.status !== "terminal")
        errors.push(new Failure("retirement_unconfirmed", "Original Memory operation is not terminal", 0))
    }
    return errors
  }

  private async work<T>(
    body: (before: (request: unknown) => Promise<void>, signal: AbortSignal, id: string) => Promise<T>,
    signal: AbortSignal,
    id: string,
    close?: () => Promise<void>,
  ) {
    let debt: unknown
    const result = await outcome(
      body(
        async (request) => {
          if (debt !== undefined) throw new Error("Duplicate original journal publication")
          debt = {
            format: "raya.memory.control.uncertainty",
            version: 2,
            protocol: this.#setup.protocol,
            root: this.#setup.root,
            request,
          }
          await this.settings.record(debt, this.#lease)
        },
        signal,
        id,
      ),
    )
    const errors: unknown[] = result.ok ? [] : [result.error]
    const closure = await this.closure(id, signal, result, debt, close)
    if (debt !== undefined && closure.proof && closure.cleanup.length === 0) {
      const settled = await outcome(
        this.#client.settle(closure.proof, id, () => this.settings.settle(debt, this.#lease, closure.proof!)),
      )
      if (!settled.ok) closure.cleanup.push(settled.error)
      if (settled.ok) this.#retired = true
    }
    errors.push(...closure.cleanup)
    if (signal.aborted) errors.push(signal.reason)
    raise(errors)
    if (!result.ok) throw result.error
    if (debt === undefined) throw new Error("Original Memory journal was not observed")
    if (!closure.proof) throw new Error("Original completed Memory settlement was not observed")
    return result.value
  }

  private async closure(
    id: string,
    signal: AbortSignal,
    result: Outcome<unknown>,
    debt: unknown,
    close?: () => Promise<void>,
  ) {
    let proof = this.#client.settlement(id)
    const cleanup: unknown[] = []
    // Complete original terminal evidence precedes worker handoff. Health and
    // DELETE acknowledgments cannot clear debt or authorize an idle release.
    if (debt !== undefined && !proof) cleanup.push(...(await this.inspect(id, !result.ok || signal.aborted)))
    if (!proof) proof = this.proof(id, result.ok && !signal.aborted, cleanup)
    if (result.ok && !signal.aborted && proof) {
      const idle = await outcome(this.#client.idle(id, signal))
      if (!idle.ok) cleanup.push(idle.error)
    }
    const closed = await outcome(Promise.resolve().then(() => close?.()))
    if (!closed.ok) cleanup.push(closed.error)
    if (debt !== undefined && closed.ok) this.#recovery = { id, debt }
    if (!proof) proof = this.proof(id, result.ok && !signal.aborted, cleanup)
    return { proof, cleanup }
  }

  private proof(id: string, completed: boolean, errors: readonly unknown[]) {
    if (errors.length) return undefined
    return (completed ? this.#client.completed(id) : undefined) ?? this.#client.closed(id)
  }

  /** Retry inspection of this retained request only; never resubmit or adopt cold metadata. */
  reconcile() {
    const retained = this.#recovery
    const error = [...this.#failures][0]
    if (this.#slot || !retained || error === undefined || this.#retired)
      return Promise.reject(new Failure("control_uncertain", "Original failed Memory request is unavailable", 0))
    const controller = new AbortController()
    const job = (async () => {
      const errors = await this.inspect(retained.id, false)
      raise(errors)
      const completed = this.#client.completed(retained.id)
      if (completed) await this.#client.idle(retained.id, controller.signal, true)
      const proof = completed ?? this.#client.closed(retained.id)
      if (!proof)
        throw new Failure("retirement_unconfirmed", "Original terminal and residency evidence are unconfirmed", 0)
      await this.#client.settle(proof, retained.id, () => this.settings.settle(retained.debt, this.#lease, proof))
      this.#retired = true
      return error
    })()
    const slot = { controller, job }
    this.#slot = slot
    void job
      .finally(() => {
        if (this.#slot === slot) this.#slot = undefined
      })
      .catch(() => undefined)
    return job
  }

  async settle() {
    const slot = this.#slot
    if (slot) await outcome(slot.job)
    raise([...this.#failures])
  }

  retired() {
    return this.#retired && this.#slot === undefined
  }

  async stop() {
    this.#closed = true
    const slot = this.#slot
    slot?.controller.abort()
    await this.settle()
  }

  dispose() {
    this.#closed = true
    if (!this.#ending) this.#ending = this.stop()
    return this.#ending
  }
}
