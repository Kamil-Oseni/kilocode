import { randomUUID } from "node:crypto"
import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"

/** Metadata for actual admitted operations only. It does not authorize capture. */
export class StatePublication {
  readonly generation = randomUUID()
  private root: Readonly<{ kind: "json" | "sqlite"; path: string }> | undefined
  private closed = false
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly errors: unknown[] = []
  private retirement: Promise<void> | undefined

  constructor(private readonly file: string) {}

  run<T>(body: (file: string) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("State publication is retired"))
    const job = this.perform(body)
    this.jobs.add(job)
    void job.then(
      () => this.jobs.delete(job),
      (err) => {
        this.errors.push(err)
        this.jobs.delete(job)
      },
    )
    return job
  }

  private async perform<T>(body: (file: string) => Promise<T>) {
    const root = await resolveProfileRoot({ kind: "json", path: this.file })
    if (this.root && this.root.path !== root.path) throw new Error("State publication physical root changed")
    const lease = await acquireProfileRoot(root)
    this.root = lease.root
    const errors: unknown[] = []
    const result = await this.check(lease.root.path)
      .then(() => {
        if (root.path !== lease.root.path) throw new Error("State publication physical root changed during admission")
      })
      .then(() => body(root.path))
      .then(
        (value) => ({ value }),
        (err: unknown) => {
          errors.push(err)
          return undefined
        },
      )
    await lease.release().catch((err: unknown) => errors.push(err))
    if (errors.length) throw new AggregateError(errors, "State publication failed")
    if (!result) throw new Error("State publication result is unavailable")
    return result.value
  }

  async check(file: string) {
    const root = await resolveProfileRoot({ kind: "json", path: this.file })
    if (root.path !== file) throw new Error("State publication physical root changed")
  }

  snapshot() {
    return Object.freeze({
      generation: this.generation,
      roots: Object.freeze(this.root ? [Object.freeze({ ...this.root })] : []),
    })
  }

  retire(): Promise<void> {
    if (this.retirement) return this.retirement
    this.closed = true
    this.retirement = (async () => {
      while (this.jobs.size) await Promise.allSettled([...this.jobs])
      if (this.errors.length) throw new AggregateError([...this.errors], "State publication retirement failed")
    })()
    return this.retirement
  }
}
