import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { createAnchored, inspectFile, replaceChecked } from "@kilocode/sandbox"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import * as EncodedIO from "./encoded-io"

const wrap = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

export type Review =
  | {
      readonly exists: true
      readonly proof: { readonly dev: string; readonly ino: string }
      readonly sha256: string
    }
  | {
      readonly exists: false
      readonly anchor: { readonly path: string; readonly identity: { readonly dev: string; readonly ino: string } }
    }

export const review = (fs: FSUtil.Interface, path: string): Effect.Effect<Review, Error> =>
  Effect.gen(function* () {
    if (!(yield* fs.existsSafe(path))) {
      return { exists: false as const, anchor: yield* EncodedIO.anchor(fs, dirname(path)) }
    }
    const proof = yield* inspectFile(path).pipe(Effect.mapError(wrap))
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError(wrap))
    return {
      exists: true as const,
      proof,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  })

export const commit = (path: string, bytes: Uint8Array, review: Review) =>
  (review.exists
    ? replaceChecked(path, bytes, review.proof, review.sha256)
    : createAnchored(path, bytes, review.anchor.path, review.anchor.identity)
  ).pipe(Effect.mapError(wrap))
