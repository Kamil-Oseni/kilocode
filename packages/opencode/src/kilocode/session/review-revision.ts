import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Schema } from "effect"
import type { Snapshot } from "@/snapshot"
import type { MessageV2 } from "@/session/message-v2"

type Diff = { file?: string; patch?: string; before?: string; after?: string; status?: string; generation?: string }

export class ReviewConflict extends Schema.TaggedErrorClass<ReviewConflict>()(
  "ReviewConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Versioned wire identity; legacy content-only responses retain the original tuple. */
export function revision(diff: Diff) {
  const content = [diff.file, diff.patch, diff.before, diff.after, diff.status]
  return createHash("sha256")
    .update(JSON.stringify(diff.generation === undefined ? content : ["v2", ...content, diff.generation]))
    .digest("hex")
}

/** Check the entire declared scope; additions, removals and aliases cannot silently widen it. */
export function verify(
  diffs: readonly Diff[],
  expected: Readonly<Record<string, string>>,
  directory: string,
  files?: readonly string[],
) {
  return Effect.gen(function* () {
    if (files?.length === 0)
      return yield* new ReviewConflict({ message: "No files were selected. Refresh the review before retrying." })
    const normalize = (file: string) => {
      const resolved = path.resolve(directory, file)
      return process.platform === "win32" ? resolved.toLowerCase() : resolved
    }
    const scope = files ? new Set(files.map(normalize)) : undefined
    const actual = new Map<string, Diff>()
    for (const diff of diffs) {
      if (!diff.file) continue
      const key = normalize(diff.file)
      if (scope && !scope.has(key)) continue
      if (actual.has(key))
        return yield* new ReviewConflict({
          message: "Ambiguous file paths in the current review. Refresh the review before retrying.",
        })
      actual.set(key, diff)
    }
    const supplied = new Map(Object.entries(expected).map(([file, hash]) => [normalize(file), hash]))
    if (
      supplied.size !== Object.keys(expected).length ||
      supplied.size !== actual.size ||
      (scope && scope.size !== actual.size)
    ) {
      return yield* new ReviewConflict({
        message: "The files in this review have changed. Refresh the review before retrying.",
      })
    }
    for (const [key, diff] of actual) {
      if (supplied.get(key) !== revision(diff)) {
        return yield* new ReviewConflict({
          message: "The reviewed content has changed. Refresh the review before retrying.",
        })
      }
    }
    return [...actual.values()].map((diff) => path.resolve(directory, diff.file!))
  })
}

/** Pin each reviewed file to its latest completed agent snapshot before accepting or restoring it. */
export const workspace = Effect.fn("ReviewRevision.workspace")(function* (
  snapshot: Snapshot.Interface,
  messages: readonly MessageV2.WithParts[],
  files: readonly string[],
  directory: string,
) {
  const normalize = (file: string) => {
    const resolved = path.resolve(directory, file)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  const wanted = new Set(files.map(normalize))
  const versions = new Map<string, string | undefined>()
  for (const message of messages) {
    const finish = message.parts.findLast((part) => part.type === "step-finish" && !!part.snapshot)
    const hash = finish?.type === "step-finish" ? finish.snapshot : undefined
    for (const part of message.parts) {
      if (part.type !== "patch") continue
      for (const file of part.files) {
        const key = normalize(file)
        if (wanted.has(key)) versions.set(key, hash)
      }
    }
  }
  const patches: Snapshot.Patch[] = []
  for (const file of files) {
    const hash = versions.get(normalize(file))
    if (!hash)
      return yield* new ReviewConflict({
        message:
          "A completed snapshot is not available for every reviewed file. Inspect and reconcile the files before retrying.",
      })
    patches.push({ hash, files: [file] })
  }
  if (!(yield* snapshot.matches(patches)))
    return yield* new ReviewConflict({
      message:
        "Workspace files changed outside the reviewed edits or could not be verified. Inspect and reconcile the files before retrying.",
    })
  return patches
})
