import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { lstat, opendir, realpath, stat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Exit, Option, TxReentrantLock } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { make as revocations } from "../task/effect-revocation"
import * as capacity from "../task/capacity"
import { eq, inArray } from "drizzle-orm"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectCapsule as Capsules,
  RoutineEffectRevocation as Intents,
} from "@opencode-ai/core/kilocode/routine-effect.sql"

type Kind = "principal" | "organization" | "goal" | "run" | "session" | "delegation" | "workspace" | "config"
type Key = { kind: Kind; principal: string }
type Mode = "create" | "replace" | "write" | "update" | "remove"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const namespace = new Set([
  "agent",
  "agent-runs",
  "agent-memory",
  "routine-reports",
  "agent-stage",
  "agent-executions",
  "agent-execution-reviews",
  "scheduler-owners",
  "scheduler-reviews",
  "goal",
  "goal-stops",
  "goal-child-reservations",
  "goal-charge-reservations",
  "agent-starts",
  "agent-claims",
  "agent-recovery",
  "delegation-reviews",
  "agent-removals",
  "agent-initialized",
  "restore-hold",
  "agent-archive",
  "checkpoint",
  "delegation",
])
const relevant = (key: readonly string[]) => key[0] === "raya" && (namespace.has(key[1] ?? "") || key[1] === "chief")
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const fail = () => new Error("Routine authority publication is unavailable or changed")
const omit = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([field]) => !fields.includes(field)))

function keys(key: readonly string[], prior: unknown, next: unknown) {
  const result = new Map<string, Key>()
  const add = (kind: Kind, id: unknown) => {
    if (typeof id !== "string" || !id || id.includes("\0") || Buffer.byteLength(id) > 256) throw fail()
    result.set(`${kind}:${id}`, { kind, principal: id })
    if (result.size > 1024) throw fail()
  }
  const fields = (row: Record<string, unknown>) => {
    for (const [field, kind] of [
      ["agentID", "principal"],
      ["runID", "run"],
      ["sessionID", "session"],
      ["goalID", "goal"],
      ["organizationID", "organization"],
      ["delegationID", "delegation"],
    ] as const) {
      if (row[field] !== undefined) add(kind, row[field])
    }
  }
  const changed = (left: unknown, right: unknown, field: string, select: (row: Record<string, unknown>) => void) => {
    const rows = (value: unknown) => {
      if (value === undefined) return new Map<string, Record<string, unknown>>()
      if (!Array.isArray(value)) throw fail()
      const result = new Map<string, Record<string, unknown>>()
      for (const row of value) {
        if (!object(row) || typeof row[field] !== "string" || result.has(row[field])) throw fail()
        result.set(row[field], row)
      }
      return result
    }
    const before = rows(left)
    const after = rows(right)
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (isDeepStrictEqual(before.get(id), after.get(id))) continue
      for (const row of [before.get(id), after.get(id)]) if (row) select(row)
    }
  }
  if (key[1] === "agent") {
    const rows = (value: unknown) => {
      if (value === undefined) return new Map<string, Record<string, unknown>>()
      if (!Array.isArray(value)) throw fail()
      const items = new Map<string, Record<string, unknown>>()
      for (const row of value) {
        if (!object(row) || typeof row.id !== "string" || items.has(row.id)) throw fail()
        items.set(row.id, row)
      }
      return items
    }
    const before = rows(prior)
    const after = rows(next)
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(id)
      const right = after.get(id)
      if (
        isDeepStrictEqual(
          left && omit(left, ["avatar", "updatedAt", "nextRun", "execution"]),
          right && omit(right, ["avatar", "updatedAt", "nextRun", "execution"]),
        )
      )
        continue
      add("principal", id)
    }
  } else {
    const projection = (value: unknown) => {
      if (!object(value)) return value
      if (key[1] === "agent-executions") return omit(value, ["updatedAt"])
      if (
        ["goal-child-reservations", "goal-charge-reservations"].includes(key[1] ?? "") &&
        Array.isArray(value.leases) &&
        value.leases.every((row) => object(row) && typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt))
      )
        return { ...value, leases: value.leases.map((row) => (object(row) ? omit(row, ["expiresAt"]) : row)) }
      return value
    }
    if (isDeepStrictEqual(projection(prior), projection(next))) return []
    if (
      ["scheduler-owners", "agent-initialized", "restore-hold", "agent-archive", "checkpoint", "delegation"].includes(
        key[1] ?? "",
      )
    )
      return undefined
    if (key[1] === "agent-runs") {
      changed(object(prior) ? prior.runs : prior, object(next) ? next.runs : next, "id", (row) => {
        add("run", row.id)
        add("session", row.sessionID)
      })
    }
    if (key[1] === "agent-removals") {
      changed(prior, next, "agentID", (row) => add("principal", row.agentID))
      return [...result.values()]
    }
    if (["agent-runs", "agent-memory", "agent-stage"].includes(key[1] ?? "")) add("principal", key[2])
    if (key[1] === "goal" || key[1] === "goal-stops") {
      add("session", key[2])
      if (key[1] === "goal") add("goal", key[2])
    }
    if (key[1] === "chief") add("session", key[3])
    for (const row of [prior, next]) {
      if (row === undefined) continue
      if (!object(row)) {
        if (key[1] === "agent-runs" && Array.isArray(row)) continue
        throw fail()
      }
      if (key[1] === "routine-reports") {
        if (typeof row.id !== "string" || key[2] !== hash(row.id)) throw fail()
        // Report references describe execution; publishing a card must not
        // retire the worker, run or conversations it observes.
        add("config", `routine-report:${key[2]}`)
        continue
      }
      fields(row)
      if (key[1] === "agent-starts" && object(row.organizationPolicy)) fields(row.organizationPolicy)
      if (["goal-child-reservations", "goal-charge-reservations"].includes(key[1] ?? "") && row.goalID !== undefined)
        add("session", row.goalID)
      if (
        (key[1] === "agent-executions" || key[1] === "agent-starts") &&
        (typeof row.runID !== "string" || key[2] !== hash(row.runID))
      )
        throw fail()
      if (object(row.identity)) fields(row.identity)
      if (object(row.record)) fields(row.record)
      if (key[1] === "agent-claims" || key[1] === "agent-recovery") {
        const claim = key[1] === "agent-claims" ? row : row.claim
        if (!object(claim) || typeof claim.agentID !== "string" || key[2] !== hash(claim.agentID)) throw fail()
        fields(claim)
        add("run", claim.id)
      }
      if (key[1] === "delegation-reviews") {
        if (!object(row.prior) || typeof row.prior.id !== "string" || key[2] !== hash(row.prior.id)) throw fail()
        fields(row.prior)
        add("delegation", row.prior.id)
        for (const field of ["senderID", "recipientID"])
          if (row.prior[field] !== undefined) add("principal", row.prior[field])
        for (const field of ["parentRunID", "childRunID"])
          if (row.prior[field] !== undefined) add("run", row.prior[field])
      }
    }
    if (!result.size) throw fail()
  }
  if (result.size > 1024) throw fail()
  return [...result.values()]
}

function raw(fs: FSUtil.Interface, target: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(target, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") throw fail()
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (bytes <= 64 * 1024 * 1024) {
        const part = yield* file.readAlloc(Math.min(65536, 64 * 1024 * 1024 + 1 - bytes))
        if (Option.isNone(part) || !part.value.length) break
        chunks.push(part.value)
        bytes += part.value.length
      }
      if (bytes > 64 * 1024 * 1024) throw fail()
      return Buffer.concat(chunks, bytes)
    }),
  ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
}

/** Only a negative association of original services; no profile equivalence or native enrollment is granted. */
export function make(fs: FSUtil.Interface, database: Database.Interface | undefined, directory: string) {
  const db = database?.db
  const barrier = database && revocations(database)
  const pins = new Map<string, { path: string; dev: bigint; ino: bigint }>()
  const mapping: { file?: string } = {}
  const observe = Effect.fn("StorageAuthority.observe")(function* () {
    if (!mapping.file) throw fail()
    for (const file of [directory, mapping.file]) {
      const pin = yield* Effect.tryPromise({
        try: async () => {
          const physical = await realpath(file)
          const normalized = (value: string) =>
            process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)
          if (normalized(physical) !== normalized(file)) throw fail()
          const source = await lstat(file)
          if (source.isSymbolicLink() || (file === directory && !source.isDirectory())) throw fail()
          const info = await stat(physical, { bigint: true })
          return { path: physical, dev: info.dev, ino: info.ino }
        },
        catch: (cause) => new FSUtil.FileSystemError({ method: "authorityBinding", cause }),
      })
      const prior = pins.get(file)
      if (prior && !isDeepStrictEqual(prior, pin)) throw fail()
      pins.set(file, pin)
    }
  })
  const bind = Effect.fn("StorageAuthority.bind")(function* () {
    if (!db) throw fail()
    if (!mapping.file) {
      const rows = yield* db.all<{ name: string; file: string }>("PRAGMA database_list").pipe(Effect.orDie)
      const selected = rows.find((row) => row.name === "main")
      if (!selected?.file || !path.isAbsolute(selected.file)) throw fail()
      yield* fs.ensureDir(directory)
      mapping.file = selected.file
    }
    yield* observe()
  })
  const physical = Effect.fn("StorageAuthority.physical")(function* (key: readonly string[]) {
    yield* Effect.tryPromise({
      try: async () => {
        let parent = directory
        for (const [index, part] of key.entries()) {
          const name = index === key.length - 1 ? `${part}.json` : part
          const stream = await opendir(parent)
          let found = false
          let count = 0
          for await (const row of stream) {
            if (++count > 65536) throw fail()
            if (row.name === name) found = true
            if (process.platform === "win32" && row.name.toLowerCase() === name.toLowerCase() && row.name !== name)
              throw fail()
          }
          if (!found) return
          parent = path.join(parent, name)
          const info = await lstat(parent)
          if (info.isSymbolicLink() || (index < key.length - 1 ? !info.isDirectory() : !info.isFile())) throw fail()
          const current = await realpath(parent)
          if (path.normalize(current) !== path.normalize(parent)) throw fail()
        }
      },
      catch: (cause) => new FSUtil.FileSystemError({ method: "authorityTarget", cause }),
    })
  })
  // This absence observation never enrolls a writer or grants effect authority.
  // Published revocations remain retained; unresolved originals always refuse.
  const empty = Effect.fn("StorageAuthority.empty")(function* () {
    if (!db) throw fail()
    yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const scopes = yield* tx
              .select({ id: Scopes.id })
              .from(Scopes)
              .where(eq(Scopes.state, "active"))
              .limit(1)
              .all()
            const capsules = yield* tx
              .select({ id: Capsules.id })
              .from(Capsules)
              .where(eq(Capsules.state, "active"))
              .limit(1)
              .all()
            const intents = yield* tx
              .select({ id: Intents.id })
              .from(Intents)
              .where(inArray(Intents.state, ["requested", "uncertain"]))
              .limit(1)
              .all()
            if (scopes.length || capsules.length || intents.length) throw fail()
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
  return {
    run<A, E>(
      key: string[],
      target: string,
      rw: TxReentrantLock.TxReentrantLock,
      mode: Mode,
      content: unknown,
      update: ((value: unknown) => void) | undefined,
      enter: (body: Effect.Effect<A, E | FSUtil.Error>) => Effect.Effect<A, E | FSUtil.Error>,
      body: (value: unknown) => Effect.Effect<A, E>,
      read?: () => Effect.Effect<unknown, E>,
    ): Effect.Effect<A, E | FSUtil.Error> {
      if (
        key.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[\\/\0]/.test(part) ||
            (process.platform === "win32" && /[.: ]$|:/.test(part)),
        )
      )
        return Effect.die(fail())
      if (
        key[0]?.toLowerCase() === "raya" &&
        (key[0] !== "raya" ||
          ((namespace.has(key[1]?.toLowerCase() ?? "") || key[1]?.toLowerCase() === "chief") &&
            key[1] !== key[1]?.toLowerCase()))
      )
        return Effect.die(fail())
      key = [...key]
      if (!relevant(key))
        return enter(
          TxReentrantLock.withWriteLock(
            rw,
            Effect.gen(function* () {
              const value = update ? (read ? yield* read() : yield* fs.readJson(target)) : content
              if (update) update(value)
              return yield* body(value)
            }),
          ),
        )
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!barrier) throw fail()
          yield* bind()
          yield* physical(key)
          const before = yield* restore(TxReentrantLock.withReadLock(rw, raw(fs, target)))
          if ((mode === "create" && before !== undefined) || (mode === "remove" && before === undefined))
            return yield* restore(
              enter(
                TxReentrantLock.withWriteLock(
                  rw,
                  Effect.gen(function* () {
                    yield* observe()
                    yield* physical(key)
                    const current = yield* raw(fs, target)
                    if (before === undefined ? current !== undefined : !current?.equals(before)) throw fail()
                    return yield* body(content)
                  }),
                ),
              ),
            )
          if (update && before === undefined) {
            if (!read) throw fail()
            yield* restore(TxReentrantLock.withReadLock(rw, read()))
            throw fail()
          }
          const prior =
            before === undefined
              ? undefined
              : (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(before)) as unknown)
          if (!update && mode !== "remove")
            capacity.check(
              content,
              key[1] === "agent" ? capacity.roster : capacity.legacy,
              "Routine authority publication",
            )
          const next = mode === "remove" ? undefined : update ? structuredClone(prior) : structuredClone(content)
          if (update) update(next)
          if (next !== undefined)
            capacity.check(
              next,
              key[1] === "agent" ? capacity.roster : capacity.legacy,
              "Routine authority publication",
            )
          const encoded = next === undefined ? undefined : JSON.stringify(next)
          if (encoded !== undefined && Buffer.byteLength(encoded) > (key[1] === "agent" ? 16 : 64) * 1024 * 1024)
            throw fail()
          const published = encoded === undefined ? undefined : (JSON.parse(encoded) as unknown)
          const selected = keys(key, prior, published)
          if (selected === undefined) yield* empty()
          const owner =
            selected && selected.length > 0
              ? yield* barrier
                  .revoke({
                    request: hash(
                      JSON.stringify({
                        nonce: randomUUID(),
                        key,
                        mode,
                        before: before && hash(before.toString("base64")),
                        after: encoded && hash(encoded),
                      }),
                    ),
                    reason: "Original filesystem authority publication",
                    keys: selected,
                  })
                  .pipe(Effect.orDie)
              : undefined
          const exit = yield* restore(
            enter(
              TxReentrantLock.withWriteLock(
                rw,
                Effect.gen(function* () {
                  yield* observe()
                  yield* physical(key)
                  const current = yield* raw(fs, target)
                  if (before === undefined ? current !== undefined : !current?.equals(before)) throw fail()
                  return yield* body(published)
                }),
              ),
            ),
          ).pipe(Effect.exit)
          const finish = owner
            ? yield* barrier
                .finish(owner, Exit.isSuccess(exit) ? "published" : "uncertain")
                .pipe(Effect.orDie, Effect.exit)
            : Exit.succeed(undefined)
          if (Exit.isFailure(finish)) {
            if (Exit.isFailure(exit)) return yield* Effect.failCause(Cause.combine(exit.cause, finish.cause))
            return yield* Effect.failCause(finish.cause)
          }
          return yield* exit
        }),
      )
    },
  }
}
