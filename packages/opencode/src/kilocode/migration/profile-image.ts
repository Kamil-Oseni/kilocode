import { createHash } from "node:crypto"
import { createReadStream, constants } from "node:fs"
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import z from "zod"
import { assertImage, type Image } from "@opencode-ai/core/kilocode/source-offline"
import type { select } from "./profile-selection"
import { GlobalScopes } from "@opencode-ai/core/kilocode/source-scopes"

type Roles = z.infer<typeof GlobalScopes>
type Selection = Awaited<ReturnType<typeof select>> & Readonly<{ globals?: readonly Roles[] }>
type Root = Selection["roots"][number]
type Value = Readonly<{
  original: Selection["roots"]
  roots: readonly Root[]
  profile: Selection["profile"]
  namespaces: readonly Readonly<{ original: Readonly<Roles>; staged: Readonly<Roles> }>[]
  stores: readonly Readonly<{ original: string; staged?: string; present: boolean }>[]
}>
const brand: unique symbol = Symbol("derived-profile-image")
export type Working = Readonly<{ [brand]: true }>
const states = new WeakMap<
  object,
  { image: Image; selected: Selection["roots"]; value: Value; active: boolean; mapped: ReadonlyMap<string, string> }
>()
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const hash = async (file: string) => {
  const sum = createHash("sha256")
  for await (const bytes of createReadStream(file)) sum.update(bytes)
  return sum.digest("hex")
}

/** Derived readers remain bound to the actual held raw image and this callback lifetime. */
export function assertWorking(token: unknown): Value {
  const state = typeof token === "object" && token !== null ? states.get(token) : undefined
  if (!state?.active) throw new Error("Derived profile image is unavailable or expired")
  assertImage(state.image, state.selected)
  return state.value
}

/** Exact declared mappings stay live-bound even when absent SQLite roots have no reader path. */
export function lookup(token: Working, file: string, kind: Root["kind"] = "json") {
  const value = assertWorking(token)
  if (!value.original.some((root) => root.kind === kind && key(root.path) === key(file)))
    throw new Error("Requested profile path is not an exact declared image root")
  const staged = states.get(token)?.mapped.get(key(file))
  if (!staged) throw new Error("Requested profile root has no present reader mapping")
  return staged
}

/** Native metadata binds the copied bytes to their actual held source object, not the new staging inode. */
export function origin(token: Working, file: string) {
  const staged = lookup(token, file)
  const state = states.get(token)
  if (!state) throw new Error("Derived profile image is unavailable")
  const raw = assertImage(state.image, state.selected)
  const records = raw.files.filter((record) => key(record.original) === key(file) && key(record.staged) === key(staged))
  if (records.length !== 1) throw new Error("Declared file lacks exact native source identity")
  const record = records[0]
  return Object.freeze({ dev: String(record.volume), ino: record.index, bytes: record.bytes, digest: record.digest })
}

/** Read-only accounting metadata remains tied to the current final native image lifetime. */
export function inventory(token: Working) {
  const value = assertWorking(token)
  const state = states.get(token)
  if (!state) throw new Error("Derived profile image is unavailable")
  const raw = assertImage(state.image, state.selected)
  return Object.freeze({
    roots: Object.freeze(
      raw.roots.map((root) =>
        Object.freeze({ kind: root.kind, path: root.original, directory: root.directory, absent: !!root.absence }),
      ),
    ),
    files: Object.freeze(
      raw.files.map((file) =>
        Object.freeze({
          path: file.original,
          dev: String(file.volume),
          ino: file.index,
          bytes: file.bytes,
          digest: file.digest,
          ...(file.modified === undefined ? {} : { modified: file.modified }),
        }),
      ),
    ),
    globals: Object.freeze(value.namespaces.map((item) => item.original)),
    directories: raw.directories
      ? Object.freeze(
          raw.directories.map((item) =>
            Object.freeze({
              path: item.original,
              dev: String(item.volume),
              ino: item.index,
              children: Object.freeze(
                item.children.map((child) =>
                  Object.freeze({
                    name: child.name,
                    directory: child.directory,
                    dev: String(child.volume),
                    ino: child.index,
                  }),
                ),
              ),
            }),
          ),
        )
      : undefined,
    directoryCoverage: raw.directories ? ("verified" as const) : ("unavailable" as const),
  })
}

/** Recover SQLite exclusively in private copies; immutable raw WAL/SHM and source files stay unopened. */
export async function withWorking<A>(image: Image, selected: Selection, body: (token: Working) => Promise<A>) {
  const raw = assertImage(image, selected.roots)
  const control = await realpath(raw.control)
  const working = await mkdtemp(path.join(control, "working-"))
  const mapped = new Map<string, string>()
  const roots: Root[] = []
  const stores: { original: string; staged?: string; present: boolean }[] = []
  const token = Object.freeze({ [brand]: true as const })
  const errors: unknown[] = []
  const result: { outcome?: { value: A } } = {}
  try {
    for (const [index, root] of selected.roots.entries()) {
      assertImage(image, selected.roots)
      const entry = raw.roots[index]
      if (entry.kind !== root.kind || key(entry.original) !== key(root.path))
        throw new Error("Derived profile root differs from held raw mapping")
      if (root.kind === "json") {
        mapped.set(key(root.path), entry.staged)
        roots.push(Object.freeze({ kind: root.kind, path: entry.staged }))
        continue
      }
      if (entry.absence) {
        if (
          key(root.path) === key(selected.profile.database) ||
          (selected.profile.exports && key(root.path) === key(selected.profile.exports))
        )
          throw new Error("Selected SQLite profile is absent from held image")
        stores.push(Object.freeze({ original: root.path, present: false }))
        continue
      }
      const directory = path.join(working, String(index))
      await mkdir(directory)
      const database = path.join(directory, path.basename(root.path))
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = raw.files.find(
          (file) => key(file.staged) === key(entry.staged + suffix) && key(file.original) === key(root.path + suffix),
        )
        if (!file) {
          if (!suffix) throw new Error("Raw image omits selected SQLite file")
          continue
        }
        await copyFile(file.staged, database + suffix, constants.COPYFILE_EXCL)
        if ((await hash(database + suffix)) !== file.digest)
          throw new Error("Private SQLite copy differs from raw image")
      }
      assertImage(image, selected.roots)
      const db = new Database(database, { strict: true })
      try {
        z.object({ quick_check: z.literal("ok") })
          .strict()
          .parse(db.query("PRAGMA quick_check").get())
        z.object({ busy: z.literal(0), log: z.number().int(), checkpointed: z.number().int() })
          .strict()
          .parse(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get())
      } finally {
        db.close()
      }
      mapped.set(key(root.path), database)
      roots.push(Object.freeze({ kind: "sqlite", path: database }))
      stores.push(Object.freeze({ original: root.path, staged: database, present: true }))
    }
    function lookup(file: string) {
      const value = mapped.get(key(file))
      if (!value) throw new Error("Selected profile path lacks a held image mapping")
      return value
    }
    const preferences = Object.fromEntries(
      Object.entries(selected.profile.preferences).map(([name, file]) => [
        name,
        path.join(lookup(path.dirname(file)), path.basename(file)),
      ]),
    )
    const profile = Object.freeze({
      database: lookup(selected.profile.database),
      storage: lookup(selected.profile.storage),
      data: lookup(selected.profile.data),
      preferences: Object.freeze(preferences),
      exports: selected.profile.exports ? lookup(selected.profile.exports) : undefined,
    })
    // Each role needs its own declared logical image mapping, including absent roles.
    // An outer directory mapping alone never authorizes arbitrary descendants.
    const namespaces = Object.freeze(
      (selected.globals ?? []).map((input) => {
        const original = Object.freeze(GlobalScopes.parse(input))
        const staged = Object.freeze(
          GlobalScopes.parse(Object.fromEntries(Object.entries(original).map(([role, file]) => [role, lookup(file)]))),
        )
        return Object.freeze({ original, staged })
      }),
    )
    const state = {
      image,
      selected: selected.roots,
      value: Object.freeze({
        original: selected.roots,
        roots: Object.freeze(roots),
        profile,
        namespaces,
        stores: Object.freeze(stores),
      }),
      active: true,
      mapped: new Map(mapped),
    }
    states.set(token, state)
    try {
      result.outcome = { value: await body(token) }
    } finally {
      state.active = false
    }
  } catch (err) {
    errors.push(err)
  }
  try {
    // This directory was generated under the private native registry; verify it before recursive cleanup.
    const actual = await realpath(working)
    if (key(actual) !== key(working) || key(path.dirname(actual)) !== key(control))
      throw new Error("Private SQLite cleanup directory changed")
    await rm(actual, { recursive: true })
  } catch (err) {
    errors.push(err)
  }
  if (errors.length || !result.outcome) throw new AggregateError(errors, "Derived profile image failed")
  return result.outcome.value
}
