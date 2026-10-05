import path from "node:path"
import { lstat, mkdir, readlink, realpath } from "node:fs/promises"
import { Cause, Effect, Exit } from "effect"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  resolveProfileRoot,
} from "@opencode-ai/core/kilocode/profile-maintenance"
import type { SnapshotRuntime } from "./runtime"
import { SnapshotAdmission } from "./admission"

/** Actual workspace mutation admission; serialized patch paths never confer authority. */
export namespace SnapshotWorkspace {
  export type Input = { worktree: string; files: readonly string[] }
  type Owner = Pick<ReturnType<typeof SnapshotRuntime.install>, "run">
  type Lease = Awaited<ReturnType<typeof acquireProfileRoot>>
  type Pin = { dev: bigint; ino: bigint }
  const inside = (root: string, file: string) => {
    const relative = path.relative(root, file)
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  const absent = (err: unknown) => !!err && typeof err === "object" && "code" in err && err.code === "ENOENT"

  export function run<A, E, R>(
    input: Input,
    body: (check: Effect.Effect<void>) => Effect.Effect<A, E, R>,
    ownership?: Owner,
  ) {
    return Effect.suspend(() => {
      const selected = { worktree: path.resolve(input.worktree), files: [...input.files] }
      const work = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => realpath(selected.worktree))
          const files = [
            ...new Set(
              selected.files.map((file) => {
                const target = path.resolve(selected.worktree, file)
                if (target === selected.worktree || !inside(selected.worktree, target))
                  throw new Error("Snapshot target is outside its workspace")
                return path.join(root, path.relative(selected.worktree, target))
              }),
            ),
          ]
          const canonical = yield* Effect.promise(() =>
            Promise.all(files.map((file) => resolveProfileRoot({ kind: "json", path: file }))),
          )
          if (canonical.some((target) => !inside(root, target.path)))
            throw new Error("Snapshot canonical target escapes its workspace")
          const dirs = new Set([root])
          for (const file of [...files, ...canonical.map((target) => target.path)]) {
            for (let dir = path.dirname(file); inside(root, dir); dir = path.dirname(dir)) {
              dirs.add(dir)
              if (dir === root) break
            }
          }
          const pins = new Map<string, Pin>()
          const missing = new Set<string>()
          const directory = async (dir: string) => {
            const info = await lstat(dir, { bigint: true }).catch((err: unknown) => {
              if (absent(err)) return undefined
              throw err
            })
            if (info && (!info.isDirectory() || info.isSymbolicLink()))
              throw new Error("Snapshot parent is not a regular directory")
            return info
          }
          for (const dir of dirs) {
            const info = yield* Effect.promise(() => directory(dir))
            if (info) pins.set(dir, { dev: info.dev, ino: info.ino })
            if (!info) missing.add(dir)
          }
          if (!pins.has(root)) throw new Error("Snapshot workspace is unavailable")
          const links = async () => {
            for (const file of files) {
              const info = await lstat(file).catch((err: unknown) => {
                if (absent(err)) return undefined
                throw err
              })
              if (!info?.isSymbolicLink()) continue
              const target = path.resolve(path.dirname(file), await readlink(file))
              const canonical = await resolveProfileRoot({ kind: "json", path: target })
              if (!inside(root, canonical.path)) throw new Error("Snapshot leaf link escapes its workspace")
            }
          }
          const validate = async () => {
            if ((await realpath(selected.worktree)) !== root)
              throw new Error("Snapshot workspace canonical binding changed")
            for (const [dir, pin] of pins) {
              const info = await directory(dir)
              if (!info || info.dev !== pin.dev || info.ino !== pin.ino)
                throw new Error("Snapshot parent physical identity changed")
            }
            await links()
          }
          yield* Effect.promise(validate)
          const paths = [...new Set([...dirs, ...files])]
          const roots = yield* Effect.promise(() =>
            Promise.all(paths.map((file) => resolveProfileRoot({ kind: "json", path: file }))),
          )
          if (roots.some((scope) => !inside(root, scope.path)))
            throw new Error("Snapshot canonical target escapes its workspace")
          const targets = new Set(files)
          const leaves = new Set(roots.flatMap((scope, index) => (targets.has(paths[index]) ? [scope.id] : [])))
          const scopes = [...new Map(roots.map((scope) => [scope.id, scope])).values()].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          )
          const leases: Lease[] = []
          const check = Effect.promise(validate)
          const operation = Effect.gen(function* () {
            for (const scope of scopes) {
              // Creation precedes descendant publication, while the exact parent and existing ancestors are held.
              for (const dir of [...missing].sort((a, b) => a.length - b.length)) {
                if (scope.path === dir || !inside(dir, scope.path)) continue
                yield* check
                yield* Effect.promise(async () => {
                  await mkdir(dir)
                  const info = await directory(dir)
                  if (!info) throw new Error("Snapshot owned parent creation failed")
                  pins.set(dir, { dev: info.dev, ino: info.ino })
                  missing.delete(dir)
                })
                yield* check
              }
              const cover = leases.find((lease) => lease.root.path === root)
              const lease = yield* Effect.promise(() =>
                // Exact leaf markers retain their original canonical key through intentional link replacement.
                // Their historical roots remain explicit; this is not namespace-only history.
                cover && !leaves.has(scope.id) ? acquireCoveredProfileRoot(scope, cover) : acquireProfileRoot(scope),
              )
              leases.push(lease)
              if (lease.id !== scope.id) throw new Error("Snapshot target changed during admission")
            }
            if (missing.size) throw new Error("Snapshot parent creation was not admitted")
            yield* check
            return yield* restore(Effect.suspend(() => body(check)))
          })
          const result = yield* Effect.exit(operation)
          const errors: unknown[] = []
          if (Exit.isFailure(result)) errors.push(Cause.squash(result.cause))
          yield* Effect.promise(() => validate().catch((err: unknown) => errors.push(err)))
          for (const lease of leases.reverse())
            yield* Effect.promise(() => lease.release().catch((err: unknown) => errors.push(err)))
          if (errors.length > 1)
            return yield* Effect.die(new AggregateError(errors, "Snapshot workspace mutation and retirement failed"))
          if (Exit.isFailure(result) && errors.length === 1) return yield* Effect.failCause(result.cause)
          if (errors.length === 1) return yield* Effect.die(errors[0])
          return yield* Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause)
        }),
      )
      const admission = { namespaces: [selected.worktree] }
      return ownership ? ownership.run(admission, work) : SnapshotAdmission.make().run(admission, () => work)
    })
  }
}
