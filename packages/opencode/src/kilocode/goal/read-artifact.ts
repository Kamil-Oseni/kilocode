import { createHash } from "node:crypto"
import { Cause, Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { KiloReadObject } from "@/kilocode/tool/read-object"
import { scanner } from "./read-format"

export const read = <A extends { metadata: object; output?: string }, E, R>(
  fs: FSUtil.Interface,
  file: KiloReadObject.File,
  work: Effect.Effect<A, E, R>,
  abort?: AbortSignal,
) =>
  Effect.gen(function* () {
    const fingerprint = Effect.tryPromise(async (signal) => {
      const hash = createHash("sha256")
      const format = scanner()
      const parts: Buffer[] = []
      let size = 0
      for await (const bytes of file.stream(abort ? AbortSignal.any([abort, signal]) : signal)) {
        hash.update(bytes)
        format.add(bytes)
        size += bytes.length
        if (size <= 8192) parts.push(Buffer.from(bytes))
        else parts.length = 0
      }
      return {
        hash: hash.digest("hex"),
        format: format.finish(),
        text: size <= 8192 ? Buffer.concat(parts).toString("utf8") : undefined,
      }
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
        initial.value.hash !== digest.hash ||
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
        sha256: digest.hash,
        mode: Number(after.mode),
        bytes: Number(after.size),
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) || abort?.aborted
          ? Effect.interrupt
          : Effect.succeed({ version: 1 as const, status: "unavailable" as const, path: file.requested }),
      ),
    )
    const format = Option.isSome(initial) ? initial.value.format : undefined
    const display = result.metadata as {
      display?: {
        type?: unknown
        text?: unknown
        lineStart?: unknown
        lineEnd?: unknown
        totalLines?: unknown
        truncated?: unknown
      }
    }
    const text = Option.isSome(initial) ? initial.value.text : undefined
    const lines = text?.replace(/\r\n|\r/g, "\n").replace(/\n$/, "")
    const complete =
      text !== undefined &&
      display.display?.lineStart === 1 &&
      display.display.lineEnd === display.display.totalLines &&
      display.display.truncated === false &&
      (display.display.text === lines || display.display.text === lines?.replace(/^\ufeff/, ""))
    const encoded = complete ? JSON.stringify(text).replace(/</g, "\\u003c") : undefined
    const content = encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= 8192 ? encoded : undefined
    const output =
      revision.status === "captured" && format && display.display?.type === "file" && typeof result.output === "string"
        ? {
            ...result,
            output: `${result.output}\n<file-format encoding="${format.encoding}" bom="${format.bom ? "UTF-8" : "none"}" line-endings="${format.endings}" final-newline="${format.newline}" bytes="${format.bytes}" sha256="${revision.sha256}" />${content !== undefined ? `\n<file-content-json encoding="UTF-8" complete="true" bytes="${format.bytes}" sha256="${revision.sha256}">\n${content}\n</file-content-json>` : ""}`,
          }
        : result
    return { ...output, metadata: { ...result.metadata, rayaRevision: revision } }
  })
