import { Effect } from "effect"
import { stat } from "node:fs/promises"
import { assertPath, current } from "./context"
import {
  createAnchored as anchored,
  createChecked as create,
  removeChecked as remove,
  replaceChecked as replace,
  validateChecked as validate,
  writeChecked as write,
} from "./checked-write"
import { currentRunner } from "./mutation"
import type { Identity } from "./checked-write"
import {
  cleanup as cleanupTransaction,
  commit as commitTransaction,
  rollback as rollbackTransaction,
  stage as stageTransaction,
  type Entry,
  type Proof,
} from "./checked-transaction"

const wrap = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

export const inspect = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(path, { bigint: true })
      return { dev: info.dev.toString(), ino: info.ino.toString() }
    },
    catch: wrap,
  })

export const validateFile = (path: string, identity: Identity, sha256: string) =>
  Effect.tryPromise({
    try: () => validate(path, identity, sha256),
    catch: wrap,
  })

export function createFile(path: string, data: Uint8Array) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) {
      return yield* Effect.tryPromise({
        try: () => create(path, data),
        catch: wrap,
      })
    }
    yield* assertPath(path, "writeFileExclusive")
    const run = yield* currentRunner
    return yield* run(profile, {
      op: "writeFileExclusive",
      path,
      data: Buffer.from(data).toString("base64"),
    })
  })
}

export function createAnchored(path: string, data: Uint8Array, root: string, identity: Identity) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) {
      return yield* Effect.tryPromise({
        try: () => anchored(path, data, root, identity),
        catch: wrap,
      })
    }
    yield* assertPath(path, "writeFileAnchored")
    const run = yield* currentRunner
    return yield* run(profile, {
      op: "writeFileAnchored",
      path,
      data: Buffer.from(data).toString("base64"),
      root,
      identity,
    })
  })
}

export function writeChecked(path: string, data: Uint8Array, identity: Identity, sha256: string) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) {
      return yield* Effect.tryPromise({
        try: () => write(path, data, identity, sha256),
        catch: wrap,
      })
    }
    yield* assertPath(path, "writeFileChecked")
    const run = yield* currentRunner
    return yield* run(profile, {
      op: "writeFileChecked",
      path,
      data: Buffer.from(data).toString("base64"),
      identity,
      sha256,
    })
  })
}

export function replaceChecked(path: string, data: Uint8Array, identity: Identity, sha256: string) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) {
      return yield* Effect.tryPromise({
        try: () => replace(path, data, identity, sha256),
        catch: wrap,
      })
    }
    yield* assertPath(path, "replaceFileChecked")
    const run = yield* currentRunner
    return yield* run(profile, {
      op: "replaceFileChecked",
      path,
      data: Buffer.from(data).toString("base64"),
      identity,
      sha256,
    })
  })
}

export function removeChecked(path: string, identity: Identity, sha256: string) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) {
      return yield* Effect.tryPromise({
        try: () => remove(path, identity, sha256),
        catch: wrap,
      })
    }
    yield* assertPath(path, "removeFileChecked")
    const run = yield* currentRunner
    return yield* run(profile, { op: "removeFileChecked", path, identity, sha256 })
  })
}

function parse(value: string | undefined): Proof {
  const proof: unknown = value === undefined ? undefined : JSON.parse(value)
  if (
    !proof ||
    typeof proof !== "object" ||
    !("identity" in proof) ||
    !proof.identity ||
    typeof proof.identity !== "object" ||
    !("dev" in proof.identity) ||
    typeof proof.identity.dev !== "string" ||
    !/^\d+$/.test(proof.identity.dev) ||
    !("ino" in proof.identity) ||
    typeof proof.identity.ino !== "string" ||
    !/^\d+$/.test(proof.identity.ino) ||
    !("sha256" in proof) ||
    typeof proof.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.sha256)
  )
    throw new TypeError("Filesystem worker returned an invalid transaction proof")
  return { identity: { dev: proof.identity.dev, ino: proof.identity.ino }, sha256: proof.sha256 }
}

export function prepareTransaction(entry: Entry, data: Uint8Array) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile)
      return yield* Effect.tryPromise({
        try: () => stageTransaction(entry, data),
        catch: wrap,
      })
    yield* assertPath(entry.target, "stageFileTransaction")
    const run = yield* currentRunner
    const value = yield* run(profile, {
      op: "stageFileTransaction",
      path: entry.target,
      entry,
      data: Buffer.from(data).toString("base64"),
    })
    return yield* Effect.try({ try: () => parse(value), catch: wrap })
  })
}

export function publishTransaction(entry: Entry) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) return yield* Effect.tryPromise({ try: () => commitTransaction(entry), catch: wrap })
    yield* assertPath(entry.target, "commitFileTransaction")
    const run = yield* currentRunner
    return yield* run(profile, { op: "commitFileTransaction", path: entry.target, entry })
  })
}

export function restoreTransaction(entry: Entry) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) return yield* Effect.tryPromise({ try: () => rollbackTransaction(entry), catch: wrap })
    yield* assertPath(entry.target, "rollbackFileTransaction")
    const run = yield* currentRunner
    return yield* run(profile, { op: "rollbackFileTransaction", path: entry.target, entry })
  })
}

export function finalizeTransaction(entry: Entry, committed: boolean) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) return yield* Effect.tryPromise({ try: () => cleanupTransaction(entry, committed), catch: wrap })
    yield* assertPath(entry.target, "cleanupFileTransaction")
    const run = yield* currentRunner
    return yield* run(profile, { op: "cleanupFileTransaction", path: entry.target, entry, committed })
  })
}

export type { Identity as FileIdentity } from "./checked-write"
export type { Entry as TransactionEntry, Proof as TransactionProof } from "./checked-transaction"
