import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { binding, inspect } from "@opencode-ai/core/kilocode/markdown-publication"
import { PlanArtifact } from "./plan-artifact"
import { PlanPublication } from "./plan-publication"
import * as EncodedIO from "./tool/encoded-io"

/** A sidecar is individually atomic; it is not an atomic commit with its source markdown. */
export function save(file: string, plan: unknown, digest: string, scope?: string) {
  const target = PlanArtifact.sidecar(file)
  return PlanPublication.run(
    [file, target],
    FSUtil.Service.use((fs) =>
      Effect.gen(function* () {
        if (!path.isAbsolute(file) || !/\.md$/i.test(file) || !/^[a-f0-9]{64}$/.test(digest))
          return yield* Effect.die(new Error("Plan source binding is invalid"))
        const value = yield* Effect.sync(() => Schema.decodeUnknownSync(PlanArtifact.Info)(structuredClone(plan)))
        const text = JSON.stringify(value, null, 2)
        yield* PlanPublication.limit(Buffer.byteLength(text))
        const original = yield* Effect.promise(() => inspect(file))
        const before = binding(original)
        if (!before || before.digest !== digest || before.bytes > 1048576)
          return yield* Effect.die(new Error("Plan markdown predecessor differs from its derivation"))
        const current = yield* EncodedIO.read(fs, file)
        if (current.sha256 !== digest || JSON.stringify(PlanArtifact.parse(current.text)) !== JSON.stringify(value))
          return yield* Effect.die(new Error("Structured plan differs from the genuine markdown derivation"))
        const present = yield* fs.existsSafe(target)
        const predecessor = present ? yield* EncodedIO.read(fs, target) : undefined
        const proof = present ? yield* EncodedIO.identity(target) : undefined
        const anchor = present ? undefined : yield* EncodedIO.anchor(fs, path.dirname(target))
        const check = Effect.gen(function* () {
          yield* PlanPublication.check
          const observed = yield* Effect.promise(() => inspect(file))
          if (JSON.stringify(binding(observed)) !== JSON.stringify(before))
            return yield* Effect.die(new Error("Plan markdown changed during sidecar publication"))
          return undefined
        })
        yield* check
        if (predecessor && proof) yield* EncodedIO.checked(target, text, "utf8", proof, predecessor.sha256)
        else if (anchor) yield* EncodedIO.anchored(target, text, anchor)
        else return yield* Effect.die(new Error("Plan sidecar predecessor is unavailable"))
        yield* check
        const after = yield* EncodedIO.read(fs, target)
        if (after.sha256 !== createHash("sha256").update(text).digest("hex"))
          return yield* Effect.die(new Error("Plan sidecar publication bytes differ"))
        return { source: digest, sidecar: after.sha256 }
      }),
    ),
    scope,
  )
}
