import { randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { Flock } from "../util/flock"
import { canonical } from "./database-filename"
import { admitProfileOperation } from "./profile-maintenance"
import { RuntimeRegistry } from "./runtime-registry"

async function absent(file: string) {
  const handle = await open(file, "r").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
    throw err
  })
  if (!handle) return
  await handle.close()
  throw new Error("Credential publication is uncertain; retained intent excludes credential import and mutation")
}

async function atomic(file: string, data: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(temp, "wx", 0o600)
  const errors: unknown[] = []
  try {
    await handle.writeFile(JSON.stringify(data, null, 2))
    await handle.sync()
  } catch (err) {
    errors.push(err)
  }
  try {
    await handle.close()
  } catch (err) {
    errors.push(err)
  }
  if (!errors.length) {
    try {
      await rename(temp, file)
    } catch (err) {
      errors.push(err)
    }
  }
  if (!errors.length) return
  try {
    await unlink(temp)
  } catch (err) {
    errors.push(err)
  }
  throw new AggregateError(errors, "Credential atomic publication failed")
}

/** Own accepted publication bodies until their actual native cleanup settles. */
export function publications(register: (retire: () => Promise<void>) => void = RuntimeRegistry.register) {
  const active = new Set<Promise<void>>()
  const errors: unknown[] = []
  let closed = false
  let registered = false
  let closing: Promise<void> | undefined
  const retire = () => {
    if (closing) return closing
    closed = true
    closing = Promise.all([...active]).then(() => {
      if (errors.length) throw new AggregateError([...errors], "Credential publication retirement failed")
    })
    return closing
  }
  const run = <A, E, R>(
    file: string,
    body: (channel: {
      file: string
      begin: Effect.Effect<void>
      write: (data: unknown) => Effect.Effect<void>
      clear: Effect.Effect<void>
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const done = yield* Effect.sync(() => {
        if (closed) throw new Error("Credential publication admission is closed")
        if (!registered) {
          register(retire)
          registered = true
        }
        const done = Promise.withResolvers<void>()
        active.add(done.promise)
        return done
      })
      const result = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const target = canonical(file)
            const intent = `${target}.raya-intent.json`
            for (const root of [target, intent].sort()) {
              yield* Effect.acquireRelease(
                Effect.sync(() => admitProfileOperation({ kind: "json", path: root })),
                (lease) => Effect.sync(lease.release),
              )
            }
            yield* Flock.effect(`raya.credentials:${process.platform === "win32" ? target.toLowerCase() : target}`, {
              dir: path.join(path.dirname(target), ".raya-credential-locks"),
              recover: "dead",
              timeoutMs: 5_000,
            })
            yield* Effect.promise(() => absent(intent))
            return yield* body({
              file: target,
              begin: Effect.promise(() =>
                atomic(intent, { format: "raya.credential-publication-intent", version: 1, id: randomUUID() }),
              ),
              write: (data) => Effect.promise(() => atomic(target, data)),
              clear: Effect.promise(() => unlink(intent)),
            })
          }),
        ),
      )
      yield* Effect.sync(() => {
        if (Exit.isFailure(result)) errors.push(result.cause)
        active.delete(done.promise)
        done.resolve()
      })
      return yield* result
    }).pipe(Effect.uninterruptible)
  return { run, retire }
}

export const CredentialPublication = publications()
