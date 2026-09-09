import { createHash } from "node:crypto"
import path from "node:path"
import { Cause, Effect, Option, Schema, type FileSystem } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

const Revision = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("captured"),
  path: Schema.String,
  canonical: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  mode: Schema.Number,
})

const Absent = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("absent"),
  path: Schema.String,
  parent: Schema.String,
})

const Entry = Schema.Union([Revision, Absent])
const Bundle = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("bundle"),
  revisions: Schema.Array(Entry).check(Schema.isMinLength(1)),
})

const missing = (fs: FSUtil.Interface, file: string, expected?: string) =>
  Effect.gen(function* () {
    if (!path.isAbsolute(file)) return yield* Effect.fail(new Error("Artifact path must be absolute"))
    const directory = path.dirname(file)
    const parent = yield* fs.realPath(directory)
    if (expected !== undefined && parent !== expected) return yield* Effect.fail(new Error("Artifact parent changed"))
    // Listing detects dangling symlinks too; stat/exists can incorrectly report them as absent.
    const entries = yield* fs.readDirectory(parent)
    if (
      entries.some((entry) => entry.toLowerCase() === path.basename(file).toLowerCase()) ||
      parent !== (yield* fs.realPath(directory))
    )
      return yield* Effect.fail(new Error("Artifact is present or its parent changed"))
    return { version: 1 as const, status: "absent" as const, path: file, parent }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed({ version: 1 as const, status: "unavailable" as const, path: file }),
    ),
  )

export const patch = (
  fs: FSUtil.Interface,
  changes: readonly { filePath: string; type: "add" | "update" | "delete" | "move"; movePath?: string }[],
) =>
  Effect.gen(function* () {
    const paths = new Map<string, boolean>()
    for (const change of changes) {
      paths.set(change.filePath, change.type !== "delete" && change.type !== "move")
      if (change.movePath) paths.set(change.movePath, true)
    }
    const revisions = yield* Effect.forEach(paths, ([file, present]) =>
      Effect.gen(function* () {
        if (present) return yield* capture(fs, file)
        return yield* missing(fs, file)
      }),
    )
    return { version: 1 as const, status: "bundle" as const, revisions }
  })

const same = (one: FileSystem.File.Info, two: FileSystem.File.Info) =>
  one.type === two.type &&
  one.dev === two.dev &&
  one.size === two.size &&
  one.mode === two.mode &&
  Option.getOrUndefined(one.ino) === Option.getOrUndefined(two.ino) &&
  Option.getOrUndefined(one.mtime)?.getTime() === Option.getOrUndefined(two.mtime)?.getTime()

export const capture = (fs: FSUtil.Interface, file: string, expected?: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!path.isAbsolute(file)) return yield* Effect.fail(new Error("Artifact path must be absolute"))
      const canonical = yield* fs.realPath(file)
      if (expected !== undefined && canonical !== expected)
        return yield* Effect.fail(new Error("Artifact target changed"))
      const before = yield* fs.stat(canonical)
      if (before.type !== "File") return yield* Effect.fail(new Error("Artifact is not a regular file"))
      const handle = yield* fs.open(canonical, { flag: "r" })
      if (!same(before, yield* handle.stat)) return yield* Effect.fail(new Error("Artifact changed before reading"))
      const hash = createHash("sha256")
      for (;;) {
        const bytes = yield* handle.readAlloc(64 * 1024)
        if (Option.isNone(bytes)) break
        hash.update(bytes.value)
      }
      if (
        !same(before, yield* handle.stat) ||
        !same(before, yield* fs.stat(canonical)) ||
        canonical !== (yield* fs.realPath(file))
      )
        return yield* Effect.fail(new Error("Artifact changed while reading"))
      return {
        version: 1 as const,
        status: "captured" as const,
        path: file,
        canonical,
        sha256: hash.digest("hex"),
        mode: before.mode,
      }
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed({ version: 1 as const, status: "unavailable" as const, path: file }),
    ),
  )

export const current = (value: unknown) =>
  Effect.gen(function* () {
    const saved = yield* Schema.decodeUnknownEffect(Schema.Union([Entry, Bundle]))(value)
    const fs = yield* Effect.serviceOption(FSUtil.Service)
    if (Option.isNone(fs)) return false
    for (const entry of saved.status === "bundle" ? saved.revisions : [saved]) {
      if (entry.status === "absent") {
        if ((yield* missing(fs.value, entry.path, entry.parent)).status !== "absent") return false
        continue
      }
      const now = yield* capture(fs.value, entry.path, entry.canonical)
      if (now.status !== "captured" || now.sha256 !== entry.sha256 || now.mode !== entry.mode) return false
    }
    return true
  }).pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(false))))
