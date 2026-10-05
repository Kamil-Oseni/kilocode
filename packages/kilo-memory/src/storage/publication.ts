import { createHash } from "node:crypto"
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { MemoryOperation } from "./operation"

const pending = new Map<string, Promise<void>>()
const LIMIT = 8
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

function code(err: unknown) {
  return err && typeof err === "object" && "code" in err ? err.code : undefined
}

async function owned(file: string, identity: { dev: bigint; ino: bigint }) {
  const info = await lstat(file, { bigint: true }).catch((err) => {
    if (code(err) === "ENOENT") return undefined
    throw err
  })
  if (!info) return false
  if (!info.isFile() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino)
    throw new Error("Memory temporary publication binding changed")
  return true
}

export function publish(file: string, text: string, prepare: () => Promise<void>): Promise<void> {
  const prior = pending.get(file) ?? Promise.resolve()
  const work = prior.then(async () => {
    for (let slot = 0; slot < LIMIT; slot++) {
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.memory-${slot}.tmp`)
      const published = await MemoryOperation.mutate([file, path.dirname(file), temporary], async () => {
        await prepare()
        const handle = await open(temporary, "wx", 0o600).catch((err) => {
          if (code(err) === "EEXIST") return undefined
          throw err
        })
        if (!handle) return false
        const errors: unknown[] = []
        const identity = await handle.stat({ bigint: true }).catch(async (err) => {
          await handle.close().catch((failure) => {
            throw new AggregateError([err, failure], "Memory publication inspection and close failed")
          })
          throw err
        })
        try {
          await handle.writeFile(text)
          await handle.sync()
          if (!(await owned(temporary, identity))) throw new Error("Memory temporary publication disappeared")
          await rename(temporary, file)
          if (!(await owned(file, identity)) || hash(await readFile(file)) !== hash(text))
            throw new Error("Memory final publication binding changed")
          const final = await handle.stat({ bigint: true })
          if (final.dev !== identity.dev || final.ino !== identity.ino)
            throw new Error("Memory held publication identity changed")
        } catch (err) {
          errors.push(err)
        } finally {
          await owned(temporary, identity)
            .then(async (present) => {
              if (present) await unlink(temporary)
            })
            .catch((err) => {
              errors.push(err)
            })
          await handle.close().catch((err) => {
            errors.push(err)
          })
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, "Memory publication and cleanup failed")
        return true
      })
      if (published) return
    }
    throw new Error("Memory publication exhausted its eight temporary slots")
  })
  const settled = work.then(
    () => {
      if (pending.get(file) === settled) pending.delete(file)
    },
    () => {
      if (pending.get(file) === settled) pending.delete(file)
    },
  )
  pending.set(file, settled)
  return work
}

/** Claim a stopped owner's exact file through a nonreplacement hardlink, preserving occupied slots. */
export async function reclaim(file: string, token: string) {
  for (let slot = 0; slot < LIMIT; slot++) {
    const temporary = `${file}.memory-stale-${slot}`
    const reclaimed = await MemoryOperation.mutate([file, temporary, path.dirname(file)], async () => {
      const handle = await open(file, "r")
      const errors: unknown[] = []
      const state = { linked: false, identity: undefined as { dev: bigint; ino: bigint } | undefined }
      try {
        state.identity = await handle.stat({ bigint: true })
        if ((await handle.readFile("utf8")) !== token) throw new Error("Memory stale owner token changed")
        state.linked = await link(file, temporary).then(
          () => true,
          (err) => {
            if (code(err) === "EEXIST") return false
            throw err
          },
        )
        if (state.linked) {
          const identity = state.identity
          if (!(await owned(file, identity)) || !(await owned(temporary, identity)))
            throw new Error("Memory stale owner binding disappeared")
          await unlink(file)
          if (!(await owned(temporary, identity))) throw new Error("Memory stale owner claim disappeared")
          await unlink(temporary)
        }
      } catch (err) {
        errors.push(err)
      } finally {
        await handle.close().catch((err) => {
          errors.push(err)
        })
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Memory stale owner reclamation and close failed")
      return state.linked
    })
    if (reclaimed) return
  }
  throw new Error("Memory stale owner exhausted its eight recovery slots")
}
