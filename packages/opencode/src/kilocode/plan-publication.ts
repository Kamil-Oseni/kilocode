import path from "node:path"
import os from "node:os"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises"
import { Cause, Context, Effect, Exit, Option } from "effect"
import { Global } from "@opencode-ai/core/global"
import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { InstanceRef } from "@/effect/instance-ref"
import { KiloShutdown } from "./cli/shutdown"

const local = new AsyncLocalStorage<string>()
const pending = new Set<Promise<void>>()
const failures: unknown[] = []
const nested = Context.Reference<{ groups: readonly string[]; check: () => Promise<void> } | undefined>(
  "raya/PlanPublication",
  { defaultValue: () => undefined },
)
let closing: Promise<void> | undefined
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const absent = (err: unknown) => !!err && typeof err === "object" && "code" in err && err.code === "ENOENT"
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== ".."
}

export namespace PlanPublication {
  /** Disposable integration boundary, never selected by tools or renderer input. */
  export function using<A>(root: string, body: () => A): A {
    const resolved = path.resolve(root)
    if (!path.isAbsolute(root) || !inside(path.resolve(os.tmpdir()), resolved))
      throw new Error("Plan test root must be an absolute disposable Temp descendant")
    return local.run(resolved, body)
  }

  export const check = Effect.gen(function* () {
    const current = yield* nested
    if (current) yield* Effect.promise(current.check)
  })

  export const limit = (bytes: number) =>
    Effect.gen(function* () {
      if ((yield* nested) && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1048576))
        return yield* Effect.die(new Error("Plan publication exceeds the finite file byte limit"))
      return undefined
    })

  export function drain() {
    return (closing ??= Promise.all(pending).then(() => {
      if (failures.length) throw new AggregateError(failures, "Plan publication retirement failed")
    }))
  }

  /** Only selected data/plans and the actual instance's workspace plans are profile participants. */
  export function run<A, E, R>(
    files: readonly string[],
    body: Effect.Effect<A, E, R>,
    scope?: string,
    retained: readonly { file: string; dev: string; ino: string; sha256: string }[] = [],
  ) {
    return Effect.gen(function* () {
      const instance = yield* Effect.serviceOption(InstanceRef)
      const workspace =
        Option.isSome(instance) && instance.value
          ? instance.value.worktree === "/"
            ? instance.value.directory
            : instance.value.worktree
          : undefined
      if (
        scope &&
        (!Option.isSome(instance) ||
          !instance.value ||
          key(path.resolve(scope)) !== key(path.resolve(instance.value.directory)))
      )
        return yield* Effect.die(new Error("Custom plan scope requires the genuine instance directory"))
      const roots = [
        local.getStore() ?? path.join(Global.Path.data, "plans"),
        ...(workspace ? [path.join(workspace, ".kilo", "plans")] : []),
        ...(scope ? [scope] : []),
      ]
      const selected = [...new Set(files.map((file) => path.resolve(file)))].filter((file) =>
        roots.some((root) => inside(root, file)),
      )
      if (!selected.length) return yield* body
      const current = yield* nested
      if (current) {
        if (selected.some((file) => !current.groups.includes(key(file.replace(/(?:\.plan\.json|\.md)$/i, "")))))
          return yield* Effect.die(new Error("Nested plan publication escaped original admission"))
        yield* Effect.promise(current.check)
        const result = yield* Effect.exit(body)
        const final = yield* Effect.exit(Effect.promise(current.check))
        if (Exit.isFailure(result) && Exit.isFailure(final))
          return yield* Effect.die(
            new AggregateError(
              [Cause.squash(result.cause), Cause.squash(final.cause)],
              "Plan body and namespace check failed",
            ),
          )
        if (Exit.isFailure(final)) return yield* Effect.failCause(final.cause)
        return Exit.isFailure(result) ? yield* Effect.failCause(result.cause) : result.value
      }
      if (closing) return yield* Effect.die(new Error("Plan publication is retired"))
      if (files.some((file) => !path.isAbsolute(file)) || roots.some((root) => !path.isAbsolute(root)))
        return yield* Effect.die(new Error("Plan publication scope is invalid"))
      const ticket = Promise.withResolvers<void>()
      pending.add(ticket.promise)
      const pins = new Map<string, { dev: bigint; ino: bigint }>()
      const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
      const releases: (() => Promise<void>)[] = []
      const errors: unknown[] = []
      let owned = false
      async function pin(file: string): Promise<void> {
        const stat = await lstat(file, { bigint: true }).catch((err) => {
          if (absent(err)) return undefined
          throw err
        })
        if (!stat) {
          const parent = path.dirname(file)
          if (parent === file) throw new Error("Plan physical ancestor is unavailable")
          return pin(parent)
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(file)) !== key(file))
          throw new Error("Plan namespace is not canonical")
        const before = pins.get(file)
        if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) throw new Error("Plan namespace changed")
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
            throw new Error("Plan namespace changed")
        }
      }
      async function ensure(file: string): Promise<void> {
        if (
          await lstat(file).catch((err) => {
            if (absent(err)) return undefined
            throw err
          })
        )
          return pin(file)
        await ensure(path.dirname(file))
        await check()
        await mkdir(file, { mode: 0o700 }).catch((err) => {
          if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") return
          throw err
        })
        await pin(file)
      }
      const work = Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const active = roots
            .filter((root) => selected.some((file) => inside(root, file)))
            .map((root) => path.resolve(root))
          for (const root of active) {
            await pin(path.dirname(root))
            await pin(root)
          }
          for (const file of selected) await pin(path.dirname(file))
          const parents = [...pins.keys()]
          const scopes = await Promise.all(
            [...parents, ...active].map((path) => resolveProfileRoot({ kind: "json", path })),
          )
          const ordered = [...new Map(scopes.map((root) => [root.id, root])).values()].sort((a, b) =>
            a.id < b.id ? -1 : 1,
          )
          owned = true
          for (const root of ordered) {
            leases.push(await acquireProfileRoot(root))
            await check()
          }
          registerProcessProfile([...parents, ...active, ...selected])
          // An original source and its adjacent sidecar share one cooperative key.
          const groups = [
            ...new Map(
              selected.map((file) => {
                const root = active.find((root) => inside(root, file))!
                const base = file.replace(/(?:\.plan\.json|\.md)$/i, "")
                return [key(base), { base, root }]
              }),
            ).values(),
          ].sort((a, b) => (key(a.base) < key(b.base) ? -1 : 1))
          for (const group of groups) {
            const container = path.join(path.dirname(group.root), ".raya-plan-locks")
            await ensure(container)
            const dir = path.join(container, createHash("sha256").update(key(group.base)).digest("hex") + ".lock")
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
              if (created) break
              const stat = await lstat(dir)
              if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plan lock is not a regular directory")
              if (Date.now() >= stop) throw new Error("Plan lock observation expired; original owner retained")
              await Bun.sleep(25)
            }
            const held = { identity: undefined as { dev: bigint; ino: bigint } | undefined }
            const file = path.join(dir, "owner.json")
            const text = JSON.stringify({ pid: process.pid, token: randomUUID() })
            let marker: { dev: bigint; ino: bigint } | undefined
            releases.push(async () => {
              await check()
              if (!held.identity) throw new Error("Created plan lock identity is uncertain; original lock retained")
              const stat = await lstat(dir, { bigint: true })
              if (
                !stat.isDirectory() ||
                stat.isSymbolicLink() ||
                stat.dev !== held.identity.dev ||
                stat.ino !== held.identity.ino
              )
                throw new Error("Plan original lock changed")
              if (marker) {
                const stat = await lstat(file, { bigint: true })
                if (
                  !stat.isFile() ||
                  stat.isSymbolicLink() ||
                  stat.nlink !== 1n ||
                  stat.dev !== marker.dev ||
                  stat.ino !== marker.ino ||
                  (await readFile(file, "utf8")) !== text
                )
                  throw new Error("Plan original lock metadata changed")
                await unlink(file)
              }
              await rmdir(dir)
            })
            held.identity = await lstat(dir, { bigint: true })
            await writeFile(file, text, { flag: "wx", mode: 0o600 })
            marker = await lstat(file, { bigint: true })
          }
          for (const file of selected) await ensure(path.dirname(file))
          for (const file of selected) {
            leases.push(await acquireProfileRoot(await resolveProfileRoot({ kind: "json", path: file })))
            await check()
            const stat = await lstat(file, { bigint: true }).catch((err) => {
              if (absent(err)) return undefined
              throw err
            })
            if (
              stat &&
              (!stat.isFile() ||
                stat.isSymbolicLink() ||
                (stat.nlink !== 1n && stat.nlink !== 2n) ||
                stat.size > 1048576n ||
                key(await realpath(file)) !== key(file))
            )
              throw new Error("Plan target is not a bounded canonical regular file")
            if (stat?.nlink === 2n) {
              // Only an authentic retained transaction journal can name its two-link postimage/preimage.
              const bytes = await readFile(file)
              const after = await lstat(file, { bigint: true })
              const digest = createHash("sha256").update(bytes).digest("hex")
              if (
                stat.dev !== after.dev ||
                stat.ino !== after.ino ||
                stat.size !== after.size ||
                stat.mtimeNs !== after.mtimeNs ||
                after.nlink !== 2n ||
                !retained.some(
                  (proof) =>
                    key(proof.file) === key(file) &&
                    proof.dev === String(stat.dev) &&
                    proof.ino === String(stat.ino) &&
                    proof.sha256 === digest,
                )
              )
                throw new Error("Plan hardlink lacks an exact retained transaction binding")
            }
          }
        })
        return yield* body.pipe(
          Effect.provideService(nested, {
            groups: selected.map((file) => key(file.replace(/(?:\.plan\.json|\.md)$/i, ""))),
            check,
          }),
        )
      })
      const result = yield* Effect.exit(work)
      if (Exit.isFailure(result)) errors.push(Cause.squash(result.cause))
      yield* Effect.promise(async () => {
        for (const release of releases.reverse()) await release().catch((err) => errors.push(err))
        await check().catch((err) => errors.push(err))
        for (const lease of leases.reverse()) await lease.release().catch((err) => errors.push(err))
        if (owned) failures.push(...errors)
        pending.delete(ticket.promise)
        ticket.resolve()
      })
      if (errors.length === 1 && Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
      if (errors.length === 1) return yield* Effect.die(errors[0])
      if (errors.length) return yield* Effect.die(new AggregateError(errors, "Plan publication and cleanup failed"))
      return Exit.isSuccess(result) ? result.value : yield* Effect.failCause(result.cause)
    }).pipe(Effect.uninterruptible)
  }
}

KiloShutdown.register(PlanPublication.drain)
