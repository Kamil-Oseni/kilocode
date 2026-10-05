import system from "node:process"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { Cause, Context, Effect, type Exit } from "effect"
import { canonical } from "@opencode-ai/core/kilocode/database-filename"
import { acquireProfileRoot, acquireCoveredProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { Flock } from "@opencode-ai/core/util/flock"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { isRecord } from "@/util/record"

type Data = Record<string, unknown>
type Ticket = {
  path: string
  mutated: boolean
  done: Promise<void>
  finish: () => void
  ready: Promise<void>
  guard: Promise<unknown>
  settled: Promise<void>
  complete: () => void
}
const Current = Context.Reference<Ticket | undefined>("@raya/ModelProducer", { defaultValue: () => undefined })
const missing = (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"

export namespace ModelOwner {
  export function make(
    opts: {
      register?: (close: () => Promise<void>) => void
      publish?: typeof registerProcessProfile
      activate?: () => ProfileWriterLive.Admission
    } = {},
  ) {
    const tickets = new WeakSet<Ticket>()
    const pending = new Set<Ticket>()
    const failures: unknown[] = []
    const queues = new Map<string, Promise<unknown>>()
    let closed = false
    let registered = false
    const join = async (items: ReadonlySet<Ticket>) => {
      while (items.size) await Promise.all([...items].map((ticket) => ticket.settled))
    }
    const drain = () => {
      closed = true
      return join(pending).then(() => {
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, "Model state retirement failed")
      })
    }
    const reserve = (selected: string) => {
      if (closed) throw new Error("Model state writer is retired")
      if (!registered) {
        opts.register?.(drain)
        registered = true
      }
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      let complete!: () => void
      const settled = new Promise<void>((resolve) => {
        complete = resolve
      })
      let enter!: () => void
      let refuse!: (err: unknown) => void
      const ready = new Promise<void>((resolve, reject) => {
        enter = resolve
        refuse = reject
      })
      // Scheduling can fail before update observes this separate admission barrier.
      void ready.catch(() => undefined)
      const admission = opts.activate?.()
      const guard = admission
        ? Effect.runPromiseExit(
            admission.run(Effect.sync(enter).pipe(Effect.andThen(Effect.promise(() => done)))),
          ).then((exit) => {
            if (exit._tag === "Failure") {
              const err = Cause.squash(exit.cause)
              refuse(err)
              throw err
            }
          })
        : Promise.resolve().then(enter)
      // A rejected count guard is consumed by the launch barrier and settlement.
      void guard.catch(() => undefined)
      const ticket = { path: selected, mutated: false, done, finish, ready, guard, settled, complete }
      tickets.add(ticket)
      pending.add(ticket)
      return ticket
    }
    const settle = async (ticket: Ticket, err?: unknown) => {
      if (!pending.has(ticket)) return
      if (err !== undefined && ticket.mutated) failures.push(err)
      tickets.delete(ticket)
      ticket.finish()
      await ticket.guard.catch((error) => {
        if (ticket.mutated) failures.push(error)
      })
      pending.delete(ticket)
      ticket.complete()
    }
    const update = async (ticket: Ticket, change: (data: Data) => Data) => {
      if (!tickets.has(ticket)) throw new Error("Model state producer is unavailable")
      await ticket.ready
      const root = canonical(ticket.path)
      const file = path.join(root, "model.json")
      const key = system.platform === "win32" ? file.toLowerCase() : file
      const prior = queues.get(key) ?? Promise.resolve()
      const body = prior.then(() => write(ticket, root, file, change, opts.publish ?? registerProcessProfile))
      const job = body
      const tail = job.then(
        () => undefined,
        () => undefined,
      )
      queues.set(key, tail)
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key)
      })
      return job
    }
    const group = () => {
      const active = new Set<Ticket>()
      let fenced = false
      return {
        launch<A>(selected: string, run: (ticket: Ticket) => Promise<A>): Promise<A> {
          if (fenced) return Promise.reject(new Error("Model producer generation is retired"))
          const ticket = reserve(selected)
          active.add(ticket)
          const result = (() => {
            try {
              return run(ticket)
            } catch (err) {
              return Promise.reject(err)
            }
          })().then((value) => ticket.ready.then(() => value))
          return result.then(
            async (value) => {
              await settle(ticket)
              active.delete(ticket)
              return value
            },
            async (err: unknown) => {
              await settle(ticket, err)
              active.delete(ticket)
              throw err
            },
          )
        },
        settle() {
          fenced = true
          return join(active)
        },
      }
    }
    return {
      group,
      drain,
      result: <A, E>(value: Promise<Exit.Exit<A, E>>) =>
        value.then((exit) => {
          if (exit._tag === "Failure") throw Cause.squash(exit.cause)
          return exit.value
        }),
      effect: <A, E, R>(ticket: Ticket, body: Effect.Effect<A, E, R>) => Effect.provideService(body, Current, ticket),
      change: (selected: string, change: (data: Data) => Data) =>
        group().launch(selected, (ticket) => update(ticket, change)),
      update: (change: (data: Data) => Data) =>
        Effect.flatMap(Current, (ticket) =>
          ticket
            ? Effect.tryPromise({ try: () => update(ticket, change), catch: (err) => err }).pipe(
                Effect.orDie,
                Effect.uninterruptible,
              )
            : Effect.die(new Error("Model mutation has no reserved producer")),
        ),
      snapshot: () => ({ closed, active: pending.size, failures: failures.length }),
    }
  }
  export const process = make({
    register: (close) => RuntimeRegistry.register(close),
    activate: () => ProfileWriterLive.models(),
  })
}

async function write(
  ticket: Ticket,
  root: string,
  file: string,
  change: (data: Data) => Data,
  publish: typeof registerProcessProfile,
) {
  const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
  const errors: unknown[] = []
  const lockdir = path.join(root, ".raya-model-locks")
  let lock: Awaited<ReturnType<typeof Flock.acquire>> | undefined
  let temp: string | undefined
  let locked: BigIntStats | undefined
  let stage: BigIntStats | undefined
  let value: Data = {}
  let original: string | undefined
  let pin = await lstat(root, { bigint: true }).catch((err) => {
    if (missing(err)) return undefined
    throw err
  })
  const parent = canonical(path.dirname(root))
  const anchor = await lstat(parent, { bigint: true })
  const absent = !pin
  const check = async () => {
    if (canonical(ticket.path) !== root) throw new Error("Model state namespace changed")
    const above = await lstat(parent, { bigint: true })
    if (!above.isDirectory() || above.isSymbolicLink() || above.dev !== anchor.dev || above.ino !== anchor.ino)
      throw new Error("Model state enclosing identity changed")
    const info = await lstat(pin ? root : parent, { bigint: true })
    const expected = pin ?? anchor
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev || info.ino !== expected.ino)
      throw new Error("Model state parent identity changed")
    if (locked) {
      const actual = await lstat(lockdir, { bigint: true })
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== locked.dev || actual.ino !== locked.ino)
        throw new Error("Model state lock directory changed")
    }
  }
  await check()
  try {
    ticket.mutated = true
    if (absent) leases.push(await acquireProfileRoot({ kind: "json", path: parent }))
    const namespace = await acquireProfileRoot({ kind: "json", path: root })
    leases.push(namespace)
    if (!pin) {
      await check()
      await mkdir(root)
      pin = await lstat(root, { bigint: true })
    }
    await check()
    publish(absent ? [parent, root] : [root])
    for (const target of [file, lockdir])
      leases.push(await acquireCoveredProfileRoot({ kind: "json", path: target }, namespace))
    await check()
    locked = await lstat(lockdir, { bigint: true }).catch((err) => {
      if (missing(err)) return undefined
      throw err
    })
    if (!locked) {
      await mkdir(lockdir)
      locked = await lstat(lockdir, { bigint: true })
    }
    await check()
    lock = await Flock.acquire(`raya.model-state:${system.platform === "win32" ? file.toLowerCase() : file}`, {
      dir: lockdir,
      recover: "dead",
      timeoutMs: 5000,
    })
    await check()
    const info = await lstat(file, { bigint: true }).catch((err) => {
      if (missing(err)) return undefined
      throw err
    })
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n))
      throw new Error("Model state file identity is unsafe")
    if (info) {
      const handle = await open(file, "r")
      const faults: unknown[] = []
      try {
        const held = await handle.stat({ bigint: true })
        if (held.dev !== info.dev || held.ino !== info.ino || held.size !== info.size || held.mtimeNs !== info.mtimeNs)
          throw new Error("Model state read identity changed")
        const text = await handle.readFile("utf8")
        original = text
        try {
          const data: unknown = JSON.parse(text)
          if (isRecord(data)) value = data
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err
        }
        const after = await lstat(file, { bigint: true })
        if (
          after.dev !== info.dev ||
          after.ino !== info.ino ||
          after.size !== info.size ||
          after.mtimeNs !== info.mtimeNs
        )
          throw new Error("Model state read generation changed")
      } catch (err) {
        faults.push(err)
      }
      await handle.close().catch((err) => faults.push(err))
      if (faults.length === 1) throw faults[0]
      if (faults.length) throw new AggregateError(faults, "Model state read and close failed")
    }
    value = change(value)
    temp = `${file}.${randomUUID()}.tmp`
    leases.push(await acquireCoveredProfileRoot({ kind: "json", path: temp }, namespace))
    const handle = await open(temp, "wx", info ? Number(info.mode & 0o777n) : 0o600)
    try {
      stage = await handle.stat({ bigint: true })
      await handle.writeFile(JSON.stringify(value, null, 2))
      await handle.sync()
    } catch (err) {
      errors.push(err)
    }
    await handle.close().catch((err) => errors.push(err))
    if (errors.length) throw errors.shift()
    if (!stage) throw new Error("Model state staged identity is unavailable")
    await check()
    const current = await lstat(file, { bigint: true }).catch((err) => {
      if (missing(err)) return undefined
      throw err
    })
    if (
      info
        ? !current ||
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          current.size !== info.size ||
          current.mtimeNs !== info.mtimeNs
        : current
    )
      throw new Error("Model state publication predecessor changed")
    if (current) {
      const held = await open(file, "r")
      const faults: unknown[] = []
      try {
        const before = await held.stat({ bigint: true })
        if (
          before.dev !== current.dev ||
          before.ino !== current.ino ||
          before.size !== current.size ||
          before.mtimeNs !== current.mtimeNs ||
          (await held.readFile("utf8")) !== original
        )
          throw new Error("Model state publication bytes changed")
        const after = await lstat(file, { bigint: true })
        if (
          after.dev !== current.dev ||
          after.ino !== current.ino ||
          after.size !== current.size ||
          after.mtimeNs !== current.mtimeNs
        )
          throw new Error("Model state publication identity changed")
      } catch (err) {
        faults.push(err)
      }
      await held.close().catch((err) => faults.push(err))
      if (faults.length === 1) throw faults[0]
      if (faults.length) throw new AggregateError(faults, "Model state publication read and close failed")
    }
    const actual = await lstat(temp, { bigint: true })
    if (
      !actual.isFile() ||
      actual.isSymbolicLink() ||
      actual.nlink !== 1n ||
      actual.dev !== stage.dev ||
      actual.ino !== stage.ino
    )
      throw new Error("Model state staged identity changed")
    await rename(temp, file)
    temp = undefined
    await check()
  } catch (err) {
    errors.unshift(err)
  }
  if (temp && stage) {
    const held = temp
    const pin = stage
    await (async () => {
      const info = await lstat(held, { bigint: true }).catch((err) => {
        if (missing(err)) return undefined
        throw err
      })
      if (!info) return
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.dev !== pin.dev || info.ino !== pin.ino)
        throw new Error("Model state temporary cleanup identity changed")
      await unlink(held)
    })().catch((err) => errors.push(err))
  }
  await lock?.release().catch((err) => errors.push(err))
  await check().catch((err) => errors.push(err))
  for (const lease of leases.reverse()) await lease.release().catch((err) => errors.push(err))
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Model state mutation and cleanup failed")
  return value
}
