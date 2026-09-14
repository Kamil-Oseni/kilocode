import { Effect } from "effect"
import { stat } from "node:fs/promises"
import { assertPath, current } from "./context"
import { validateChecked as validate, writeChecked as write } from "./checked-write"
import { currentRunner } from "./mutation"
import type { Identity } from "./checked-write"

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

export type { Identity as FileIdentity } from "./checked-write"
