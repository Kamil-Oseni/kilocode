import path from "node:path"
import os from "node:os"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises"
import { Cause, Effect, Exit } from "effect"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { binding, inspect } from "@opencode-ai/core/kilocode/markdown-publication"
import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { KiloShutdown } from "../cli/shutdown"

const local = new AsyncLocalStorage<string>()
const pending = new Set<Promise<void>>()
const failures: unknown[] = []
let closing: Promise<void> | undefined
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const absent = (err: unknown) => !!err && typeof err === "object" && "code" in err && err.code === "ENOENT"

export namespace ConfigPublication {
  export type Input = { files: readonly string[]; targets?: readonly string[]; roots?: readonly string[] }
  export type Transaction = {
    read(file: string): Promise<string | undefined>
    write(file: string, before: string, after: string, mode?: number): Promise<void>
    check(): Promise<void>
    remove(file: string, before: string): Promise<void>
  }

  /** Explicit disposable test boundary; production callers never select a metadata namespace. */
  export function using<A>(root: string, body: () => A): A {
    const file = path.resolve(root)
    const relative = path.relative(path.resolve(os.tmpdir()), file)
    if (!path.isAbsolute(root) || !relative || path.isAbsolute(relative) || relative.startsWith(".."))
      throw new Error("Config test metadata must be inside disposable Temp")
    return local.run(file, body)
  }

  export function drain() {
    return (closing ??= Promise.all(pending).then(() => {
      if (failures.length) throw new AggregateError(failures, "Config publication retirement failed")
    }))
  }

  export function promise<A>(input: Input, body: (tx: Transaction) => Promise<A>) {
    return Effect.runPromise(run(input, (tx) => Effect.promise(() => body(tx))))
  }

  export function run<A, E, R>(input: Input, body: (tx: Transaction) => Effect.Effect<A, E, R>) {
    return Effect.suspend(() => {
      if (closing) return Effect.die(new Error("Config publication is retired"))
      const files = [...new Set(input.files.map((file) => path.resolve(file)))].sort()
      const targets = [...new Set((input.targets ?? input.files).map((file) => path.resolve(file)))].sort()
      if (
        !files.length ||
        input.files.some((file) => !path.isAbsolute(file)) ||
        input.targets?.some((file) => !path.isAbsolute(file)) ||
        new Set(files.map(key)).size !== files.length ||
        targets.some((file) => !files.includes(file))
      )
        return Effect.die(new Error("Config publication paths are invalid"))
      const account = local.getStore() ?? os.userInfo().homedir
      if (!path.isAbsolute(account)) return Effect.die(new Error("Config account identity is unavailable"))
      const home = path.resolve(account)
      const metadata = path.join(home, ".raya-config-rmw-locks")
      const joined = Promise.withResolvers<void>()
      pending.add(joined.promise)
      const errors: unknown[] = []
      const pins = new Map<string, { dev: bigint; ino: bigint }>()
      const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
      const locks: (() => Promise<void>)[] = []
      let owned = false
      async function pin(file: string): Promise<void> {
        const stat = await lstat(file, { bigint: true }).catch((err) => {
          if (absent(err)) return undefined
          throw err
        })
        if (!stat) {
          const parent = path.dirname(file)
          if (parent === file) throw new Error("Config physical ancestor is unavailable")
          return pin(parent)
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(file)) !== key(file))
          throw new Error("Config parent is not canonical")
        const before = pins.get(file)
        if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) throw new Error("Config namespace changed")
        pins.set(file, { dev: stat.dev, ino: stat.ino })
      }
      async function check() {
        for (const [file, before] of pins) {
          const stat = await lstat(file, { bigint: true })
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            key(await realpath(file)) !== key(file)
          )
            throw new Error("Config namespace changed")
        }
      }
      async function ensure(file: string): Promise<void> {
        const stat = await lstat(file).catch((err) => {
          if (absent(err)) return undefined
          throw err
        })
        if (stat) return pin(file)
        await ensure(path.dirname(file))
        await check()
        await mkdir(file, { mode: 0o700 })
        await pin(file)
      }
      async function lock(file: string) {
        const name = createHash("sha256")
          .update("raya.config.rmw:" + key(file))
          .digest("hex")
        const dir = path.join(metadata, name + ".lock")
        const stop = Date.now() + 300000
        while (true) {
          await check()
          const created = await mkdir(dir, { mode: 0o700 }).then(
            () => true,
            (err) => {
              if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") return false
              throw err
            },
          )
          if (!created) {
            const stat = await lstat(dir)
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Config lock is not a regular directory")
            if (Date.now() >= stop) throw new Error("Config lock observation expired; original owner is retained")
            await new Promise((resolve) => setTimeout(resolve, 25))
            continue
          }
          const stat = await lstat(dir, { bigint: true })
          const marker = path.join(dir, "owner.json")
          const text = JSON.stringify({ pid: process.pid, token: randomUUID(), file: key(file) })
          let object: Awaited<ReturnType<typeof lstat>> | undefined
          locks.push(async () => {
            await check()
            const after = await lstat(dir, { bigint: true })
            if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino)
              throw new Error("Config original lock directory changed")
            if (object) {
              const after = await lstat(marker)
              if (
                !after.isFile() ||
                after.isSymbolicLink() ||
                after.nlink !== 1 ||
                after.dev !== object.dev ||
                after.ino !== object.ino ||
                (await readFile(marker, "utf8")) !== text
              )
                throw new Error("Config original lock metadata changed")
              await unlink(marker)
            }
            await rmdir(dir)
          })
          await writeFile(marker, text, { flag: "wx", mode: 0o600 })
          object = await lstat(marker)
          return
        }
      }
      const tx: Transaction = {
        check,
        async remove(file, before) {
          file = path.resolve(file)
          if (!targets.includes(file)) throw new Error("Config removal is outside the transaction")
          const original = binding(await inspect(file))
          if (!original || (await tx.read(file)) !== before) throw new Error("Config migration source changed")
          await check()
          if (JSON.stringify(binding(await inspect(file))) !== JSON.stringify(original))
            throw new Error("Config migration identity changed")
          await unlink(file)
          await check()
        },
        async read(file) {
          file = path.resolve(file)
          if (!files.includes(file)) throw new Error("Config read is outside the transaction")
          await check()
          const before = binding(await inspect(file))
          if (!before) return undefined
          if (before.bytes > 1048576) throw new Error("Config bytes exceed the finite publication bound")
          const bytes = await readFile(file)
          if (
            createHash("sha256").update(bytes).digest("hex") !== before.digest ||
            JSON.stringify(binding(await inspect(file))) !== JSON.stringify(before)
          )
            throw new Error("Config predecessor changed while reading")
          return bytes.toString("utf8")
        },
        async write(file, before, after, mode) {
          file = path.resolve(file)
          if (!targets.includes(file) || Buffer.byteLength(after) > 1048576)
            throw new Error("Config publication is outside the transaction")
          await check()
          const original = await lstat(file).catch((err) => {
            if (absent(err)) return undefined
            throw err
          })
          const ticket = await ConfigIntent.writing(file, before, after, {
            atomic: true,
            mode: mode ?? (original ? original.mode & 0o777 : 0o600),
          })
          try {
            const receipt = await ticket.publish()
            await ticket.complete(receipt)
          } catch (err) {
            ticket.fail(err)
            throw err
          }
          await check()
        },
      }
      const work = Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await pin(home)
          for (const root of input.roots ?? []) {
            if (!path.isAbsolute(root)) throw new Error("Config scope is not absolute")
            await pin(path.resolve(root))
          }
          for (const file of files) await pin(path.dirname(file))
          // The account is a pinned ancestor, not a writer whose lock may live outside the account.
          const parents = [...new Set(pins.keys())].filter((parent) => key(parent) !== key(home)).sort()
          const roots = await Promise.all(
            [...parents, metadata].map((path) => resolveProfileRoot({ kind: "json", path })),
          )
          roots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          owned = true
          for (const root of roots) {
            leases.push(await acquireProfileRoot(root))
            await check()
          }
          await mkdir(metadata, { mode: 0o700 }).catch((err) => {
            if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") return
            throw err
          })
          await pin(metadata)
          for (const file of targets) await ensure(path.dirname(file))
          for (const file of files) {
            if (
              !(await lstat(path.dirname(file)).catch((err) => {
                if (absent(err)) return undefined
                throw err
              }))
            )
              continue
            leases.push(await acquireProfileRoot(await resolveProfileRoot({ kind: "json", path: file })))
            await check()
          }
          registerProcessProfile([...parents, metadata, ...targets])
          for (const file of [...files].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)))
            await lock(file)
          await check()
        })
        return yield* body(tx)
      }).pipe(Effect.exit)
      return Effect.gen(function* () {
        const result = yield* work
        if (Exit.isFailure(result)) errors.push(Cause.squash(result.cause))
        yield* Effect.promise(async () => {
          for (const release of locks.reverse()) await release().catch((err) => errors.push(err))
          await check().catch((err) => errors.push(err))
          for (const lease of leases.reverse()) await lease.release().catch((err) => errors.push(err))
          if (owned) failures.push(...errors)
          pending.delete(joined.promise)
          joined.resolve()
        })
        if (errors.length === 1 && Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
        if (errors.length === 1) return yield* Effect.die(errors[0])
        if (errors.length) return yield* Effect.die(new AggregateError(errors, "Config publication and cleanup failed"))
        return Exit.isSuccess(result) ? result.value : yield* Effect.failCause(result.cause)
      }).pipe(Effect.uninterruptible)
    })
  }
}

KiloShutdown.register(ConfigPublication.drain)
