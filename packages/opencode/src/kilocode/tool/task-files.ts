import { createHash } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Storage } from "@/storage/storage"
import * as Files from "../task/output-scope"

export const key = "raya.task.files"
const local = (file: string) => {
  if (!file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false
  if (/[\x00-\x1f\x7f*?\[\]{}<>:"|]/.test(file)) return false
  return file
    .split(/[\\/]/)
    .every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        !/[ .]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
}
const normalized = (file: string) => {
  const value = file.replaceAll("\\", "/")
  return process.platform === "win32" ? value.toLowerCase() : value
}

/** Exact relative files in the child's actual directory; empty means no file mutations. */
export const Declared = Schema.Array(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.makeFilter((file) => (local(file) ? undefined : "Declare exact relative local files without aliases.")),
  ),
).check(
  Schema.isMaxLength(16),
  Schema.makeFilter((files) =>
    new Set(files.map(normalized)).size === files.length ? undefined : "Declared files must be distinct.",
  ),
)
export type Declared = typeof Declared.Type
export function overlap(left: Declared, right: Declared) {
  const files = new Set(left.map(normalized))
  return right.some((file) => files.has(normalized(file)))
}

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Binding = Schema.Struct({
  version: Schema.Literal(1),
  child: identity,
  parent: identity,
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  declared: Declared,
  canonical: Files.Outputs,
  branch: Schema.optional(identity),
}).check(
  Schema.makeFilter((value) =>
    value.child !== value.parent ? undefined : "Assigned file scopes require a distinct parent session.",
  ),
)
export type Binding = typeof Binding.Type
const decode = Schema.decodeUnknownSync(Binding)
const address = (session: string) => ["raya", "task-files", createHash("sha256").update(session).digest("hex")]

/** Erase only this deleted session's immutable binding; Storage.remove tolerates absence. */
export const clear = (storage: Storage.Interface, session: string) => storage.remove(address(session))

export function read(metadata?: Record<string, unknown>): Binding | undefined {
  if (metadata?.[key] === undefined) return undefined
  return decode(metadata[key])
}

export const find = Effect.fn("TaskFiles.find")(function* (storage: Storage.Interface, session: string) {
  const raw = yield* storage
    .readBounded<unknown>(address(session), 196608)
    .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
  if (raw === undefined) return undefined
  const saved = yield* Schema.decodeUnknownEffect(Binding)(raw)
  if (saved.child !== session) return yield* Effect.fail(new Error("The assigned file scope belongs to another child."))
  return saved
})

export const bind = Effect.fn("TaskFiles.bind")(function* (input: {
  session: string
  parent: string
  directory: string
  files: Declared
  storage: Storage.Interface
  fs: FSUtil.Interface
  branch?: string
}) {
  const declared = yield* Schema.decodeUnknownEffect(Declared)(input.files)
  const directory = yield* input.fs.realPath(input.directory)
  if (!path.isAbsolute(input.directory) || normalized(path.normalize(input.directory)) !== normalized(directory))
    return yield* Effect.fail(new Error("Assigned files require the child's canonical absolute directory."))
  const canonical = yield* Files.canonical(
    input.fs,
    declared.map((file) => path.join(directory, ...file.split(/[\\/]/))),
  )
  const saved = yield* Schema.decodeUnknownEffect(Binding)({
    version: 1,
    child: input.session,
    parent: input.parent,
    directory,
    declared,
    canonical,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  })
  if (yield* input.storage.create(address(input.session), saved)) return saved
  const prior = yield* find(input.storage, input.session)
  if (!isDeepStrictEqual(prior, saved))
    return yield* Effect.fail(new Error("An assigned file scope cannot be replaced or widened."))
  return saved
})

export const check = Effect.fn("TaskFiles.check")(function* (
  session: { id: string; parentID?: string; directory?: string; metadata?: Record<string, unknown> },
  targets: readonly string[],
): Effect.fn.Return<Files.Outputs | undefined, unknown> {
  const marked = read(session.metadata)
  const stores = yield* Effect.promise(() => import("@/storage/storage"))
  const storage = yield* Effect.serviceOption(stores.Storage.Service)
  if (Option.isNone(storage)) {
    if (!marked) return undefined
    return yield* Effect.fail(new Error("The assigned file-scope storage is unavailable."))
  }
  const saved = yield* find(storage.value, session.id)
  if (!saved) {
    if (!marked) return undefined
    return yield* Effect.fail(new Error("The immutable assigned file scope is unavailable."))
  }
  if (
    marked === undefined ||
    saved.parent !== session.parentID ||
    (session.directory !== undefined && normalized(saved.directory) !== normalized(session.directory)) ||
    !isDeepStrictEqual(saved, marked)
  )
    return yield* Effect.fail(new Error("The assigned file scope no longer matches this child."))
  const fs = yield* Effect.serviceOption(FSUtil.Service)
  if (Option.isNone(fs)) return yield* Effect.fail(new Error("The assigned file-scope filesystem is unavailable."))
  const canonical = yield* Files.canonical(
    fs.value,
    saved.declared.map((file) => path.join(saved.directory, ...file.split(/[\\/]/))),
  )
  if (!isDeepStrictEqual(canonical, saved.canonical))
    return yield* Effect.fail(new Error("The assigned file scope changed its original paths."))
  yield* Files.pinned(fs.value, saved.canonical)
  const paths = yield* Files.canonical(fs.value, targets)
  if (paths.some((file) => !Files.includes(saved.canonical, file)))
    return yield* Effect.fail(new Error("This file is outside the Task worker's declared files."))
  return saved.canonical
})

const mediated = new Set([
  "read",
  "file_facts",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "list",
  "semantic_search",
  "get_goal",
  "update_goal",
  "update_goal_plan",
  "inspect_team",
  "question",
  "ask_options",
  "todoread",
  "todowrite",
  "chief_message",
])

/** Declared files attenuate native tools; they never authorize opaque or delegated effects. */
export function permits(metadata: Record<string, unknown> | undefined, tool: string) {
  return read(metadata) === undefined || mediated.has(tool)
}

export function hard(metadata: Record<string, unknown> | undefined, permission: string, patterns: readonly string[]) {
  // Native reads may ask to inspect an external directory under existing parent
  // permissions. This permission is not an eligible tool or a file write grant.
  if (permission === "external_directory") {
    read(metadata)
    return []
  }
  if (permits(metadata, permission)) return []
  return patterns.map((pattern) => ({ permission, pattern, action: "deny" as const }))
}
