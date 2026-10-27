import path from "node:path"
import { Effect, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
const resolve = (fs: FSUtil.Interface, file: string): Effect.Effect<string, unknown> =>
  fs.realPath(file).pipe(
    Effect.catch((err) => {
      if (err.reason._tag !== "NotFound") return Effect.fail(err)
      const parent = path.dirname(file)
      if (parent === file) return Effect.fail(new Error("The output path has no accessible filesystem root."))
      return resolve(fs, parent).pipe(Effect.map((root) => path.join(root, path.basename(file))))
    }),
  )

const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))
const valid = (file: string) => {
  if (!path.isAbsolute(file) || /[\x00-\x1f\x7f*?\[\]{}]/.test(file) || !path.basename(file) || file.startsWith("\\\\"))
    return false
  const parts = file.split(/[\\/]/)
  if (parts.some((part) => part === "." || part === "..")) return false
  if (process.platform !== "win32") return true
  return (
    /^[a-z]:[\\/]/i.test(file) &&
    !/[<>:"|]/.test(file.slice(2)) &&
    parts
      .slice(1)
      .every((part) => !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
  )
}

/** Exact declared recipient outputs, never inferred from prose or file receipts. Empty means read-only. */
export const Outputs = Schema.Array(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.makeFilter((file) => (valid(file) ? undefined : "Output files need unambiguous absolute local paths.")),
  ),
).check(
  Schema.isMaxLength(16),
  Schema.makeFilter((files) =>
    new Set(files.map(key)).size === files.length ? undefined : "Output files must be distinct.",
  ),
)
export type Outputs = typeof Outputs.Type

export const canonical = Effect.fn("RoutineOutputs.canonical")(function* (fs: FSUtil.Interface, files: Outputs) {
  const parsed = yield* Schema.decodeUnknownEffect(Outputs)(files)
  return yield* Effect.forEach(parsed, (file) =>
    Effect.gen(function* () {
      const target = yield* resolve(fs, file)
      if (key(target) !== key(file))
        return yield* Effect.fail(new Error("Output file aliases are unsupported. Use the canonical absolute path."))
      const entry = yield* fs.stat(target).pipe(
        Effect.map((value) => ({ _tag: "Some" as const, value })),
        Effect.catch((err) =>
          err.reason._tag === "NotFound" ? Effect.succeed({ _tag: "None" as const }) : Effect.fail(err),
        ),
      )
      if (entry._tag === "Some" && entry.value.type !== "File")
        return yield* Effect.fail(new Error("An output target must be a regular file, not a directory or device."))
      return target
    }),
  )
})

/** Recheck admitted targets without rebinding a saved scope to a new alias location. */
export const pinned = Effect.fn("RoutineOutputs.pinned")(function* (fs: FSUtil.Interface, files: Outputs) {
  yield* canonical(fs, files)
})

export function includes(files: Outputs, file: string) {
  return files.some((entry) => key(entry) === key(file))
}

export function overlap(left: Outputs, right: Outputs) {
  return left.some((file) => includes(right, file))
}

const safe = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "list",
  "get_goal",
  "update_goal",
  "update_goal_plan",
  "inspect_team",
  "delegate_work",
  "question",
  "ask_options",
])
/** Only these native mediated tools can run under an exact output restriction. */
export function mediated(name: string) {
  return safe.has(name)
}
