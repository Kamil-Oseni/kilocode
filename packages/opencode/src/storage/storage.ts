import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Duration, Effect, Exit, Layer, Option, RcMap, Schema, Context, TxReentrantLock } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Git } from "@/git"
import { publish } from "@/kilocode/session/review-publish" // kilocode_change - atomic review receipt persistence
import { ProfileWriterLive } from "@/kilocode/migration/writer-live" // kilocode_change - profile migration admission
import { storageAdmission } from "@/kilocode/migration/storage-admission" // kilocode_change - cross-process JSON maintenance exclusion
import * as bounded from "@/kilocode/storage/bounded-read" // kilocode_change - bounded receipt reads
import { bind as scope } from "@/kilocode/migration/storage-scope" // kilocode_change - actual live storage selection metadata
import { Database } from "@opencode-ai/core/database/database" // kilocode_change - original selected negative authority barrier
import { make as effectAuthority } from "@/kilocode/storage/effect-authority" // kilocode_change - revoke before filesystem publication

type Migration = (dir: string, fs: FSUtil.Interface, git: Git.Interface) => Effect.Effect<void, FSUtil.Error>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is NotFoundError {
    return input instanceof NotFoundError
  }
}

export type Error = FSUtil.Error | NotFoundError

const RootFile = Schema.Struct({
  path: Schema.optional(
    Schema.Struct({
      root: Schema.optional(Schema.String),
    }),
  ),
})

const SessionFile = Schema.Struct({
  id: Schema.String,
})

const MessageFile = Schema.Struct({
  id: Schema.String,
})

const DiffFile = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
})

const SummaryFile = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  summary: Schema.Struct({ diffs: Schema.Array(DiffFile) }),
})

const decodeRoot = Schema.decodeUnknownOption(RootFile)
const decodeSession = Schema.decodeUnknownOption(SessionFile)
const decodeMessage = Schema.decodeUnknownOption(MessageFile)
const decodeSummary = Schema.decodeUnknownOption(SummaryFile)

export interface Interface {
  // kilocode_change start - exclusive receipt claim and atomic completion
  readonly create: (key: string[], content: unknown) => Effect.Effect<boolean, FSUtil.Error>
  readonly replace: (key: string[], content: unknown) => Effect.Effect<void, FSUtil.Error>
  // kilocode_change end
  readonly remove: (key: string[]) => Effect.Effect<void, FSUtil.Error>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly readBounded: <T>(key: string[], maximum: number) => Effect.Effect<T, Error | bounded.LimitError> // kilocode_change - bounded receipt reads
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, FSUtil.Error>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Storage") {}

function file(dir: string, key: string[]) {
  return path.join(dir, ...key) + ".json"
}

function missing(err: unknown) {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason) {
    return err.reason._tag === "NotFound"
  }
  return false
}

function parseMigration(text: string) {
  const value = Number.parseInt(text, 10)
  return Number.isNaN(value) ? 0 : value
}

const MIGRATIONS: Migration[] = [
  Effect.fn("Storage.migration.1")(function* (dir: string, fs: FSUtil.Interface, git: Git.Interface) {
    const project = path.resolve(dir, "../project")
    if (!(yield* fs.isDir(project))) return
    const projectDirs = yield* fs.glob("*", {
      cwd: project,
      include: "all",
    })
    for (const projectDir of projectDirs) {
      const full = path.join(project, projectDir)
      if (!(yield* fs.isDir(full))) continue
      yield* Effect.logInfo(`migrating project ${projectDir}`)
      let projectID = projectDir
      let worktree = "/"

      if (projectID !== "global") {
        for (const msgFile of yield* fs.glob("storage/session/message/*/*.json", {
          cwd: full,
          absolute: true,
        })) {
          const json = decodeRoot(yield* fs.readJson(msgFile), { onExcessProperty: "preserve" })
          const root = Option.isSome(json) ? json.value.path?.root : undefined
          if (!root) continue
          worktree = root
          break
        }
        if (!worktree) continue
        if (!(yield* fs.isDir(worktree))) continue
        const result = yield* git.run(["rev-list", "--max-parents=0", "--all"], {
          cwd: worktree,
        })
        const [id] = result
          .text()
          .split("\n")
          .filter(Boolean)
          .map((x) => x.trim())
          .toSorted()
        if (!id) continue
        projectID = id

        yield* fs.writeWithDirs(
          path.join(dir, "project", projectID + ".json"),
          JSON.stringify(
            {
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            },
            null,
            2,
          ),
        )

        yield* Effect.logInfo(`migrating sessions for project ${projectID}`)
        for (const sessionFile of yield* fs.glob("storage/session/info/*.json", {
          cwd: full,
          absolute: true,
        })) {
          const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
          yield* Effect.logInfo("copying", { sessionFile, dest })
          const session = yield* fs.readJson(sessionFile)
          const info = decodeSession(session, { onExcessProperty: "preserve" })
          yield* fs.writeWithDirs(dest, JSON.stringify(session, null, 2))
          if (Option.isNone(info)) continue
          yield* Effect.logInfo(`migrating messages for session ${info.value.id}`)
          for (const msgFile of yield* fs.glob(`storage/session/message/${info.value.id}/*.json`, {
            cwd: full,
            absolute: true,
          })) {
            const next = path.join(dir, "message", info.value.id, path.basename(msgFile))
            yield* Effect.logInfo("copying", {
              msgFile,
              dest: next,
            })
            const message = yield* fs.readJson(msgFile)
            const item = decodeMessage(message, { onExcessProperty: "preserve" })
            yield* fs.writeWithDirs(next, JSON.stringify(message, null, 2))
            if (Option.isNone(item)) continue

            yield* Effect.logInfo(`migrating parts for message ${item.value.id}`)
            for (const partFile of yield* fs.glob(`storage/session/part/${info.value.id}/${item.value.id}/*.json`, {
              cwd: full,
              absolute: true,
            })) {
              const out = path.join(dir, "part", item.value.id, path.basename(partFile))
              const part = yield* fs.readJson(partFile)
              yield* Effect.logInfo("copying", {
                partFile,
                dest: out,
              })
              yield* fs.writeWithDirs(out, JSON.stringify(part, null, 2))
            }
          }
        }
      }
    }
  }),
  Effect.fn("Storage.migration.2")(function* (dir: string, fs: FSUtil.Interface) {
    for (const item of yield* fs.glob("session/*/*.json", {
      cwd: dir,
      absolute: true,
    })) {
      const raw = yield* fs.readJson(item)
      const session = decodeSummary(raw, { onExcessProperty: "preserve" })
      if (Option.isNone(session)) continue
      const diffs = session.value.summary.diffs
      yield* fs.writeWithDirs(
        path.join(dir, "session_diff", session.value.id + ".json"),
        JSON.stringify(diffs, null, 2),
      )
      yield* fs.writeWithDirs(
        path.join(dir, "session", session.value.projectID, session.value.id + ".json"),
        JSON.stringify(
          {
            ...(raw as Record<string, unknown>),
            summary: {
              additions: diffs.reduce((sum, x) => sum + x.additions, 0),
              deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            },
          },
          null,
          2,
        ),
      )
    }
  }),
]

// kilocode_change start - the storage root is injectable so tests can point Storage at a
// temporary directory instead of remapping FSUtil paths under Global.Path.data. The
// default (production) root is unchanged and resolved lazily on first use. Note for
// callers of layerFromDir: migration 1 walks `../project` relative to this directory,
// so inject `<root>/storage` when legacy layouts must be reachable from the parent.
const make = (root?: string, admission: ProfileWriterLive.Admission = ProfileWriterLive.storage) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const git = yield* Git.Service
      const selected = yield* Effect.serviceOption(Database.Service) // kilocode_change - no fallback database for standalone storage
      const authority = effectAuthority(
        fs,
        Option.getOrUndefined(selected),
        root ?? path.join(Global.Path.data, "storage"),
      ) // kilocode_change
      const writer = storageAdmission(root ?? path.join(Global.Path.data, "storage"), admission) // kilocode_change
      const locks = yield* RcMap.make({
        lookup: () => TxReentrantLock.make(),
        idleTimeToLive: 0,
      })
      const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(
        writer.run(
          // kilocode_change - coordinate lazy migrations with profile maintenance
          Effect.gen(function* () {
            const dir = root ?? path.join(Global.Path.data, "storage")
            const marker = path.join(dir, "migration")
            const migration = yield* fs.readFileString(marker).pipe(
              Effect.map(parseMigration),
              Effect.catchIf(missing, () => Effect.succeed(0)),
              Effect.orElseSucceed(() => 0),
            )
            for (let i = migration; i < MIGRATIONS.length; i++) {
              yield* Effect.logInfo("running migration", { index: i })
              const step = MIGRATIONS[i]!
              const exit = yield* Effect.exit(step(dir, fs, git))
              if (Exit.isFailure(exit)) {
                yield* Effect.logError("failed to run migration", { index: i, cause: exit.cause })
                break
              }
              yield* fs.writeWithDirs(marker, String(i + 1))
            }
            return { dir }
          }),
        ),
        Duration.infinity,
      )
      const state = cached.pipe(Effect.tapCause(() => invalidate))

      const fail = (target: string): Effect.Effect<never, NotFoundError> =>
        Effect.fail(new NotFoundError({ message: `Resource not found: ${target}` }))

      const wrap = <A>(target: string, body: Effect.Effect<A, FSUtil.Error>) =>
        body.pipe(Effect.catchIf(missing, () => fail(target)))

      const writeJson = Effect.fnUntraced(function* (target: string, content: unknown) {
        yield* fs.writeWithDirs(target, JSON.stringify(content, null, 2))
      })

      const withResolved = <A, E>(
        key: string[],
        fn: (target: string, rw: TxReentrantLock.TxReentrantLock) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | FSUtil.Error> =>
        Effect.scoped(
          Effect.gen(function* () {
            const target = file((yield* state).dir, key)
            return yield* fn(target, yield* RcMap.get(locks, target))
          }),
        )

      // kilocode_change start - original negative barrier precedes the existing filesystem write admission
      const publication = <A, E>(
        key: string[],
        mode: "create" | "replace" | "write" | "update" | "remove",
        content: unknown,
        update: ((value: unknown) => void) | undefined,
        fn: (target: string, value: unknown) => Effect.Effect<A, E>,
        read?: (target: string) => Effect.Effect<unknown, E>,
      ): Effect.Effect<A, E | FSUtil.Error> =>
        Effect.scoped(
          Effect.gen(function* () {
            key = [...key]
            const dir = (yield* state).dir
            const target = file(dir, key)
            const rw = yield* RcMap.get(locks, target)
            return yield* authority.run<A, E>(
              key,
              target,
              rw,
              mode,
              content,
              update,
              (body) => writer.run(body),
              (value) => fn(target, value),
              read && (() => read(target)),
            )
          }),
        )
      // kilocode_change end

      const remove: Interface["remove"] = Effect.fn("Storage.remove")(function* (key: string[]) {
        yield* publication(key, "remove", undefined, undefined, (target) =>
          fs.remove(target).pipe(Effect.catchIf(missing, () => Effect.void)),
        ) // kilocode_change
      })

      const read: Interface["read"] = <T>(key: string[]) =>
        Effect.gen(function* () {
          const value = yield* withResolved(key, (target, rw) =>
            TxReentrantLock.withReadLock(rw, wrap(target, fs.readJson(target))),
          )
          return value as T
        })

      // kilocode_change start - bounded reads share the resolved root and existing read lock
      const readBounded: Interface["readBounded"] = <T>(key: string[], maximum: number) =>
        Effect.gen(function* () {
          const value = yield* withResolved(key, (target, rw) =>
            TxReentrantLock.withReadLock(
              rw,
              bounded.read(fs, target, maximum).pipe(Effect.catchIf(missing, () => fail(target))),
            ),
          )
          return value as T
        })
      // kilocode_change end

      const update: Interface["update"] = <T>(key: string[], fn: (draft: T) => void) =>
        // kilocode_change start - evaluate callback once before revocation, then exact-byte CAS under the original write gate
        publication<T, Error>(
          key,
          "update",
          undefined,
          (value) => fn(value as T),
          (target, value) => publish(fs, target, value, true).pipe(Effect.as(value as T)),
          (target) => wrap(target, fs.readJson(target)),
        )
      // kilocode_change end

      const write: Interface["write"] = (key: string[], content: unknown) =>
        publication(key, "write", content, undefined, writeJson) // kilocode_change

      const list: Interface["list"] = Effect.fn("Storage.list")(function* (prefix: string[]) {
        const dir = (yield* state).dir
        const cwd = path.join(dir, ...prefix)
        const result = yield* fs
          .glob("**/*", {
            cwd,
            include: "file",
          })
          .pipe(Effect.catch(() => Effect.succeed<string[]>([])))
        return result
          .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
          .toSorted((a, b) => a.join("/").localeCompare(b.join("/")))
      })

      const service = Service.of({
        // kilocode_change - bind the original selected storage service below
        // kilocode_change start - keep receipt publication separate from legacy JSON write behavior
        create: (key, content) =>
          publication(key, "create", content, undefined, (target, value) => publish(fs, target, value)),
        replace: (key, content) =>
          publication(key, "replace", content, undefined, (target, value) =>
            publish(fs, target, value, true).pipe(Effect.asVoid),
          ),
        // kilocode_change end
        remove,
        read,
        readBounded, // kilocode_change - bounded receipt reads
        update,
        write,
        list,
      })
      // kilocode_change start - dispose exact metadata with its original service layer
      const retire = scope(service, root ?? path.join(Global.Path.data, "storage"))
      yield* Effect.addFinalizer(() => Effect.sync(retire))
      return service
      // kilocode_change end
    }),
  )

const layer = make()

// kilocode_change start
/** Storage rooted at an explicit directory — for tests and multi-instance isolation. */
export const layerFromDir = (dir: string, admission?: ProfileWriterLive.Admission) => make(dir, admission)
/** Explicit private Storage backed by the actual Database service dependency. */
export const layerWithDatabase = (dir: string, admission?: ProfileWriterLive.Admission) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Database.Service
      return make(dir, admission).pipe(Layer.provide(Layer.succeed(Database.Service, database)))
    }),
  )
// kilocode_change end

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, Git.node, Database.node] }) // kilocode_change - capture original selected SQL service

export * as Storage from "./storage"
