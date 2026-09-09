import { createHash } from "node:crypto"
import { Cause, Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { KiloReadObject } from "@/kilocode/tool/read-object"

export const read = <A extends { metadata: object }, E, R>(
  fs: FSUtil.Interface,
  file: KiloReadObject.File,
  work: Effect.Effect<A, E, R>,
  abort?: AbortSignal,
) =>
  Effect.gen(function* () {
    const fingerprint = Effect.tryPromise(async (signal) => {
      const hash = createHash("sha256")
      for await (const bytes of file.stream(abort ? AbortSignal.any([abort, signal]) : signal)) hash.update(bytes)
      return hash.digest("hex")
    })
    const before = yield* Effect.tryPromise(() => file.handle.stat({ bigint: true })).pipe(Effect.option)
    const initial = yield* fingerprint.pipe(Effect.option)
    if (abort?.aborted) return yield* Effect.interrupt
    const result = yield* work
    if (abort?.aborted) return yield* Effect.interrupt
    const revision = yield* Effect.gen(function* () {
      if (Option.isNone(before) || Option.isNone(initial))
        return yield* Effect.fail(new Error("Read revision unavailable"))
      const digest = yield* fingerprint
      const after = yield* Effect.tryPromise(() => file.handle.stat({ bigint: true }))
      const prior = before.value
      if (
        initial.value !== digest ||
        prior.dev !== after.dev ||
        prior.ino !== after.ino ||
        prior.size !== after.size ||
        prior.mode !== after.mode ||
        prior.mtimeNs !== after.mtimeNs ||
        prior.ctimeNs !== after.ctimeNs
      )
        return yield* Effect.fail(new Error("File changed during read"))
      const canonical = yield* fs.realPath(file.requested)
      if (FSUtil.normalizePath(canonical) !== FSUtil.normalizePath(file.target))
        return yield* Effect.fail(new Error("Read target changed"))
      return {
        version: 1 as const,
        status: "captured" as const,
        path: file.requested,
        canonical,
        sha256: digest,
        mode: Number(after.mode),
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) || abort?.aborted
          ? Effect.interrupt
          : Effect.succeed({ version: 1 as const, status: "unavailable" as const, path: file.requested }),
      ),
    )
    return { ...result, metadata: { ...result.metadata, rayaRevision: revision } }
  })
