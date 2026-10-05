import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { canonical } from "@opencode-ai/core/kilocode/database-filename"
import { acquireProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Flock } from "@opencode-ai/core/util/flock"
import { held } from "./held-preferences"

const owners = new WeakMap<KiloClient, Writer>()
const history = new Set<Writer>()
let active: Writer | undefined
let closed = false
let retirement: Promise<void> | undefined
const same = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right

class Writer {
  readonly generation = randomUUID()
  private revision = 0
  private root: Readonly<{ kind: "json" | "sqlite"; path: string }> | undefined
  private data: Record<string, unknown> | undefined
  private file: string | undefined
  private closed = false
  private readonly errors: unknown[] = []
  private retirement: Promise<void> | undefined
  private tail: Promise<void>

  constructor(
    private readonly client: KiloClient,
    private readonly current: () => boolean,
    previous?: Writer,
  ) {
    // Replacement joins the old body. Sticky failure remains in history for strict retirement.
    this.tail =
      previous?.retire().then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve()
  }

  private check() {
    if (!this.current()) throw new Error("Model preference source generation changed")
  }

  private async target() {
    this.check()
    const response = await this.client.path.get()
    this.check()
    const state = response.data?.state
    if (!state || !path.isAbsolute(state)) throw new Error("Model preference source path is unavailable")
    const file = canonical(path.join(state, "model.json"))
    if (this.file && !same(file, this.file)) {
      this.closed = true
      throw new Error("Model preference source path changed within its generation")
    }
    this.file = file
    return file
  }

  run(change?: (data: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("Model preference writer is retired"))
    const job = this.tail.then(async () => {
      const file = await this.target()
      const lease = await acquireProfileRoot({ kind: "json", path: file })
      this.root = lease.root
      const errors: unknown[] = []
      let lock: Awaited<ReturnType<typeof Flock.acquire>> | undefined
      let value: Record<string, unknown> = {}
      try {
        if (!same(file, lease.root.path)) throw new Error("Model preference physical root changed during admission")
        lock = await Flock.acquire(`raya.model-state:${process.platform === "win32" ? file.toLowerCase() : file}`, {
          dir: path.join(path.dirname(file), ".raya-model-locks"),
          timeoutMs: 5000,
          recover: "dead",
        })
        this.check()
        if (!same(canonical(file), file)) throw new Error("Model preference physical path changed")
        const info = await lstat(file).catch((err: unknown) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
          throw err
        })
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
          throw new Error("Model preference file identity is unsafe")
        const text = await readFile(file, "utf8").catch((err: unknown) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return "{}"
          throw err
        })
        const data: unknown = JSON.parse(text)
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Model preference data is invalid")
        value = data as Record<string, unknown>
        this.check()
        if (change) {
          value = change(value)
          await this.publish(file, value)
        }
      } catch (err) {
        errors.push(err)
      }
      try {
        await lock?.release()
      } catch (err) {
        errors.push(err)
      }
      try {
        await lease.release()
      } catch (err) {
        errors.push(err)
      }
      if (errors.length) throw new AggregateError(errors, "Model preference publication failed")
      this.data = structuredClone(value)
      this.revision++
      return value
    })
    this.tail = job.then(
      () => undefined,
      (err) => {
        this.errors.push(err)
      },
    )
    return job
  }

  private async publish(file: string, value: Record<string, unknown>) {
    const temp = `${file}.${randomUUID()}.tmp`
    await mkdir(path.dirname(file), { recursive: true })
    const handle = await open(temp, "wx", 0o600)
    const errors: unknown[] = []
    try {
      await handle.writeFile(JSON.stringify(value, null, 2))
      await handle.sync()
    } catch (err) {
      errors.push(err)
    }
    try {
      await handle.close()
    } catch (err) {
      errors.push(err)
    }
    if (!errors.length) {
      try {
        this.check()
        if (!same(canonical(file), file)) throw new Error("Model preference physical path changed before publication")
        await rename(temp, file)
      } catch (err) {
        errors.push(err)
      }
    }
    if (!errors.length) return
    try {
      await unlink(temp)
    } catch (err) {
      errors.push(err)
    }
    throw new AggregateError(errors, "Atomic model preference publication failed")
  }

  retire(): Promise<void> {
    if (this.retirement) return this.retirement
    this.closed = true
    this.retirement = this.tail.then(() => {
      if (this.errors.length) throw new AggregateError([...this.errors], "Model preference retirement failed")
    })
    return this.retirement
  }

  /** Uses only previously admitted operations; never asks the SDK for a path. */
  async captureSnapshot() {
    await this.retire()
    return Object.freeze({
      generation: this.generation,
      revision: this.revision,
      roots: Object.freeze(this.root ? [Object.freeze({ ...this.root })] : []),
      preferences: this.data ? held({ modelState: this.data }) : undefined,
    })
  }
}

export function writer(client: KiloClient | null, current: () => boolean) {
  if (!client) throw new Error("Model preference backend is disconnected")
  if (closed) throw new Error("Model preference publications are retired")
  if (!current()) throw new Error("Model preference source generation changed")
  const previous = owners.get(client)
  if (previous) return previous
  const owner = new Writer(client, current, active)
  owners.set(client, owner)
  history.add(owner)
  active = owner
  return owner
}

/** Loaded-only terminal capture seam; creates no SDK client, path request or unused writer. */
export function retire(client?: KiloClient | null): Promise<void> {
  if (client !== undefined) return client ? (owners.get(client)?.retire() ?? Promise.resolve()) : Promise.resolve()
  if (retirement) return retirement
  closed = true
  retirement = Promise.allSettled([...history].map((owner) => owner.retire())).then((results) => {
    const errors = results.flatMap((item) => (item.status === "rejected" ? [item.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Model preference source history failed retirement")
  })
  return retirement
}

/** Historical loaded owners only, including replaced source generations. */
export async function captureSnapshot() {
  await retire()
  return Object.freeze(await Promise.all([...history].map((owner) => owner.captureSnapshot())))
}
