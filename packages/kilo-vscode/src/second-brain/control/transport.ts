import type { ChildProcess } from "node:child_process"
import { check, object, reply, sha, exact, type Op, type Generation } from "./frames"
import { valid, type Identity } from "./identity"
type Ticket = object
type Flight = {
  op: Op
  seq: number
  accepted: boolean
  promise: Promise<ReturnType<typeof reply>>
  resolve: (value: ReturnType<typeof reply>) => void
  reject: (err: Error) => void
}
type Closed = { code: number | null; signal: string | null; stdout: boolean; stderr: boolean; errors: string[] }
type Mutation = Readonly<{
  expected: string | null
  prospective?: string
  revision?: number
  enabled?: boolean
  namespace?: Generation
}>
export type Before = (
  request: Readonly<{
    op: Op
    seq: number
    bytes: number
    digest: string
    identity: Identity
    mutation: Mutation
  }>,
) => Promise<void>
type History = {
  op: Op
  seq: number
  bytes: number
  digest: string
  accepted: boolean
  verified: boolean
  mutation?: Mutation
  outcome?: Readonly<{ state: string; failure?: string; receipt?: ReturnType<typeof reply> }>
}
const owners = new Set<Transport>()
export const held = () => [...owners].map((owner) => owner.snapshot())
export async function drain() {
  const results = await Promise.allSettled([...owners].map((owner) => owner.close()))
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason)
      continue
    }
    const value = result.value
    if (value.code !== 0 || value.signal !== null || !value.stdout || !value.stderr || value.errors.length) {
      failures.push(new Error("Original control transport closure failed"))
    }
  }
  if (failures.length) throw new AggregateError(failures, "Original control closures retained")
}
export class Transport {
  private child: ChildProcess
  private root: string
  private seq = 0
  private flight?: Flight
  private chunks: Buffer = Buffer.alloc(0)
  private fenced = false
  private ending?: Promise<Closed>
  private errors: Error[] = []
  private previews = new WeakMap<
    Ticket,
    {
      id: string
      sha: string
      until: number
      policy: string
      prior: string | null
      revision: number
      enabled: boolean
      namespace: Generation
    }
  >()
  private exit: Promise<{ code: number | null; signal: string | null }>
  private stdout: Promise<void>
  private stderr: Promise<void>
  private stderrBytes = 0
  private eof = { stdout: false, stderr: false }
  private identity?: { pid: number; birth: string; parent: number; executable: string; digest: string }
  private history: History[] = []
  private contexts = new WeakSet<object>()
  private journal?: Promise<void>
  constructor(child: ChildProcess, root: string) {
    this.child = child
    this.root = root
    owners.add(this)
    check(child.stdin && child.stdout && child.stderr, "Private pipes required")
    this.exit = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        if (!child.pid) resolve({ code, signal }) // Failed spawn: no invented natural process exit.
      })
      child.once("exit", (code, signal) => {
        this.fenced = true
        resolve({ code, signal })
        if (this.flight) this.fail(new Error("Child exited before reply"))
      })
    })
    this.stdout = new Promise((resolve) =>
      child.stdout!.once("close", () => {
        if (this.chunks.length || this.flight) this.fail(new Error("Incomplete reply pipe"))
        resolve()
      }),
    )
    this.stderr = new Promise((resolve) => child.stderr!.once("close", resolve))
    child.stdout.once("end", () => {
      this.eof.stdout = true
    })
    child.stderr.once("end", () => {
      this.eof.stderr = true
    })
    child.once("error", (err) => this.fail(err))
    child.stdin.on("error", (err) => this.fail(err))
    child.stdout.on("error", (err) => this.fail(err))
    child.stderr.on("error", (err) => this.fail(err))
    child.stderr.on("data", (raw: Buffer) => {
      this.stderrBytes += raw.length
      if (this.stderrBytes > 65536) this.fail(new Error("Diagnostic bound exceeded"))
    })
    child.stdout.on("data", (raw: Buffer) => this.receive(raw))
  }
  private fail(err: Error) {
    this.fenced = true
    this.errors.push(err)
    const row = this.history[this.history.length - 1]
    if (this.flight && row?.mutation) row.outcome = Object.freeze({ state: "failed", failure: err.name })
    this.flight?.reject(err)
    this.flight = undefined
    this.chunks = Buffer.alloc(0)
  }
  private receive(raw: Buffer) {
    if (this.errors.length) return // Drain without retaining unbounded output; lifetime is still held.
    if (!this.flight) return this.fail(new Error("Unsolicited reply"))
    if (this.chunks.length + raw.length > 2097152) return this.fail(new Error("Reply bound exceeded"))
    this.chunks = Buffer.concat([this.chunks, raw])
    const index = this.chunks.indexOf(10)
    if (index === -1) return
    if (index !== this.chunks.length - 1) return this.fail(new Error("Multiple reply frames"))
    const flight = this.flight
    const bytes = this.chunks
    this.chunks = Buffer.alloc(0)
    this.flight = undefined
    try {
      const value = reply(bytes, flight.op, flight.seq, this.root)
      const row = this.history[this.history.length - 1]
      if ((row.op === "approve" || row.op === "policy_pause") && row.mutation?.prospective)
        check(
          value.policy_sha256 === row.mutation.prospective &&
            value.revision === row.mutation.revision &&
            value.enabled === row.mutation.enabled,
          "Published policy differs from original retained review",
        )
      row.verified = true
      if (row.mutation) row.outcome = Object.freeze({ state: "verified", receipt: Object.freeze({ ...value }) })
      flight.resolve(value)
    } catch (err) {
      // Authentic control refusals and malformed protocol both fence the generation.
      const cause = err instanceof Error ? err : new Error("Reply verification failed")
      this.fenced = true
      this.errors.push(cause)
      const row = this.history[this.history.length - 1]
      if (row.mutation) row.outcome = Object.freeze({ state: "failed", failure: cause.name })
      flight.reject(cause)
    }
  }
  private async request(op: Op, args: Record<string, unknown>, mutation?: Mutation, before?: Before) {
    check(
      !this.fenced && !this.flight && this.seq < 2147483647 && this.history.length < 512,
      "Control intake fenced or busy",
    )
    const seq = this.seq + 1
    const raw = Buffer.from(JSON.stringify({ format: "raya.memory.control.request", version: 1, seq, op, args }) + "\n")
    check(raw.length <= 65536, "Request bound exceeded")
    this.seq = seq
    const promise = new Promise<ReturnType<typeof reply>>((resolve, reject) => {
      this.flight = { op, seq, accepted: false, promise: undefined as never, resolve, reject }
    })
    this.flight!.promise = promise
    // Retain settlement after an observation deadline without an unhandled rejection.
    void promise.catch(() => undefined)
    const row: History = {
      op,
      seq,
      bytes: raw.length,
      digest: sha(raw),
      accepted: false,
      verified: false,
      ...(mutation ? { mutation: Object.freeze({ ...mutation }), outcome: Object.freeze({ state: "pending" }) } : {}),
    }
    this.history.push(row)
    if (before) {
      try {
        check(this.identity && row.mutation, "Original identity and mutation required for journal")
        const descriptor = Object.freeze({
          op,
          seq,
          bytes: raw.length,
          digest: row.digest,
          identity: this.identity,
          mutation: row.mutation,
        })
        const journal = Promise.resolve().then(() => before(descriptor))
        this.journal = journal
        void journal.catch(() => undefined)
        await this.observe(journal, 10000)
        check(!this.fenced && this.pending(seq), "Journal completed after intake fence")
      } catch (err) {
        const cause = err instanceof Error ? err : new Error("Mutation journal failed")
        this.fail(cause)
        row.outcome = Object.freeze({ state: "not_sent", failure: cause.name })
        throw cause
      }
    }
    this.child.stdin!.write(raw, (err) => {
      if (err) return this.fail(err)
      row.accepted = true
      if (this.flight?.seq === seq) this.flight.accepted = true
    })
    return this.observe(promise, ["state", "discard"].includes(op) ? 10000 : 30000)
  }
  private observe<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = performance.now()
      const timer = setTimeout(() => {
        this.fenced = true
        const row = this.history[this.history.length - 1]
        if (this.flight && row?.mutation) row.outcome = Object.freeze({ state: "observation_expired" })
        reject(new Error("Observation expired; child and pipes remain owned"))
      }, ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          if (performance.now() - started >= ms) {
            this.fenced = true
            reject(new Error("Late observation; child and pipes remain owned"))
            return
          }
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }
  private pending(seq: number) {
    return this.flight?.seq === seq
  }
  fence() {
    this.fenced = true
  }
  state() {
    return this.request("state", {})
  }
  async preview(names: string[], enabled: boolean) {
    check(
      names.length >= 1 && names.length <= 128 && typeof enabled === "boolean",
      "Explicit bounded source selection required",
    )
    const value = await this.request("preview", { names, enabled })
    const plan = object(value.preview)
    const namespace = exact(value)
    check(namespace, "Exact original namespace metadata required")
    const policy = object(plan.policy)
    check(
      policy.enabled === enabled &&
        Array.isArray(plan.sources) &&
        JSON.stringify(plan.sources.map((row) => object(row).relative)) === JSON.stringify(names),
      "Requested preview projection differs",
    )
    const ticket = Object.freeze({ generation: this.seq })
    this.previews.set(ticket, {
      id: String(plan.id),
      sha: String(value.preview_sha256),
      until: performance.now() + 900000,
      policy: String(plan.prospective_policy_sha256),
      prior: plan.expected_policy_sha256 === null ? null : String(plan.expected_policy_sha256),
      namespace,
      revision: Number(policy.revision),
      enabled,
    })
    return { ticket, value, namespace }
  }
  private retained(ticket: Ticket) {
    const row = this.previews.get(ticket)
    check(row && row.until > performance.now(), "Original live review required")
    return row
  }
  metadata(ticket: Ticket) {
    const row = this.retained(ticket)
    const mutation = Object.freeze({
      expected: row.prior,
      prospective: row.policy,
      revision: row.revision,
      enabled: row.enabled,
      namespace: row.namespace,
    })
    this.contexts.add(mutation)
    return mutation
  }
  async discard(ticket: Ticket) {
    const row = this.retained(ticket)
    this.previews.delete(ticket)
    return this.request("discard", { id: row.id })
  }
  // Trusted-parent primitive only. Its caller still needs genuine native human review.
  // Disposable tests invoke it as synthetic authority and explicitly claim no consent.
  async approve(ticket: Ticket, before?: Before) {
    const row = this.retained(ticket)
    this.previews.delete(ticket)
    const result = await this.request(
      "approve",
      { id: row.id, sha: row.sha },
      {
        expected: row.prior,
        prospective: row.policy,
        revision: row.revision,
        enabled: row.enabled,
        namespace: row.namespace,
      },
      before,
    )
    return result
  }
  pause(expected: string, before?: Before, context?: unknown) {
    check(/^[a-f0-9]{64}$/.test(expected), "Explicit expected policy required")
    if (context !== undefined) {
      check(
        context !== null && typeof context === "object" && this.contexts.has(context),
        "Original pause context required",
      )
      const row = context as Mutation
      check(row.expected === expected && row.enabled === false, "Pause context differs from original disabled review")
    }
    const mutation = context ? (context as Mutation) : { expected }
    return this.request("policy_pause", { expected_policy_sha256: expected }, mutation, before)
  }
  snapshot() {
    return {
      identity: this.identity,
      launchPid: this.child.pid ?? null,
      fenced: this.fenced,
      pending: this.flight ? { op: this.flight.op, seq: this.flight.seq, accepted: this.flight.accepted } : null,
      errors: this.errors.map((err) => err.name),
      history: this.history.map((row) => ({ ...row })),
      mutationUncertain: this.history.some(
        (row) => ["approve", "policy_pause"].includes(row.op) && !row.verified && row.outcome?.state !== "not_sent",
      ),
      forced: false,
      sourceProtocolUsed: false,
    }
  }
  close() {
    this.fenced = true
    if (!this.ending)
      this.ending = (async () => {
        const pending = this.flight?.promise
        // EOF is ordinary transport closure, not cancellation: an accepted body
        // continues to finish before Python can read EOF. This joins a lost reply
        // without sending another frame or replaying a possibly published mutation.
        this.child.stdin!.end()
        const [exit] = await Promise.all([
          this.exit,
          this.stdout,
          this.stderr,
          pending?.catch(() => undefined),
          this.journal?.catch((err: unknown) => {
            const cause = err instanceof Error ? err : new Error("Mutation journal failed")
            if (!this.errors.includes(cause)) this.errors.push(cause)
          }),
        ])
        owners.delete(this)
        return { ...exit, ...this.eof, errors: this.errors.map((err) => err.name) }
      })()
    return this.observe(this.ending, 30000)
  }
  bind(identity: Identity) {
    check(valid(identity, this.child) && !this.identity, "Authentic original child identity required")
    this.identity = identity
  }
}
