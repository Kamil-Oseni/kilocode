import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { chmod, link, mkdir, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises"

export interface Identity {
  readonly dev: string
  readonly ino: string
}

function stale(path: string, message = "File target or content changed after approval.", syscall = "writeFileChecked") {
  return Object.assign(new Error(message), {
    code: "ESTALE",
    path,
    syscall,
  })
}

async function verify(file: FileHandle, path: string, identity: Identity, sha256: string, syscall?: string) {
  const info = await file.stat({ bigint: true })
  if (info.dev.toString() !== identity.dev || info.ino.toString() !== identity.ino)
    throw stale(path, undefined, syscall)
  if (info.nlink !== 1n) {
    throw stale(
      path,
      "Hard-linked files cannot be changed by an agent. Replace it with an independent copy first.",
      syscall,
    )
  }
  const current = await file.readFile()
  if (createHash("sha256").update(current).digest("hex") !== sha256) throw stale(path, undefined, syscall)
  return info
}

async function anchor(path: string, identity: Identity) {
  const info = await stat(path, { bigint: true })
  if (info.dev.toString() !== identity.dev || info.ino.toString() !== identity.ino)
    throw stale(path, "File parent changed after approval.", "writeFileAnchored")
}

function same(left: string, right: string) {
  const paths = [left, right].map((item) => resolve(item))
  return process.platform === "win32" ? paths[0].toLowerCase() === paths[1].toLowerCase() : paths[0] === paths[1]
}

async function restore(hold: string, path: string, cause: unknown) {
  try {
    await link(hold, path)
    await unlink(hold)
  } catch (rollback) {
    throw Object.assign(new Error(`Checked removal failed. Retained the displaced file at ${hold}.`), {
      code: "ESTALE",
      path,
      syscall: "removeFileChecked",
      cause: new AggregateError([cause, rollback]),
    })
  }
}

async function write(file: FileHandle, path: string, data: Uint8Array) {
  for (let offset = 0; offset < data.byteLength; ) {
    const result = await file.write(data, offset, data.byteLength - offset, offset)
    if (result.bytesWritten === 0)
      throw Object.assign(new Error("Unable to finish checked file write."), { code: "EIO", path })
    offset += result.bytesWritten
  }
  await file.sync()
}

export async function createChecked(path: string, data: Uint8Array) {
  const file = await open(path, "wx")
  try {
    await write(file, path, data)
  } finally {
    await file.close()
  }
}

export async function createAnchored(path: string, data: Uint8Array, root: string, identity: Identity) {
  await anchor(root, identity)
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, "wx+")
  const outcome = await (async () => {
    await anchor(root, identity)
    const parent = await realpath(dirname(path))
    if (!same(parent, dirname(path))) throw stale(path, "File parent changed after approval.", "writeFileAnchored")
    await write(file, path, data)
  })().then(
    () => ({ ok: true as const }),
    (cause: unknown) => ({ ok: false as const, cause }),
  )
  if (outcome.ok) {
    await file.close()
    return
  }
  const info = await file.stat({ bigint: true })
  const current = await file.readFile()
  await file.close()
  try {
    await removeChecked(
      path,
      { dev: info.dev.toString(), ino: info.ino.toString() },
      createHash("sha256").update(current).digest("hex"),
    )
  } catch (cleanup) {
    throw Object.assign(new Error(`Anchored creation failed and its private file could not be removed at ${path}.`), {
      code: "ESTALE",
      path,
      syscall: "writeFileAnchored",
      cause: new AggregateError([outcome.cause, cleanup]),
    })
  }
  throw outcome.cause
}

export async function validateChecked(path: string, identity: Identity, sha256: string) {
  const file = await open(path, "r")
  try {
    await verify(file, path, identity, sha256)
  } finally {
    await file.close()
  }
}

export async function writeChecked(path: string, data: Uint8Array, identity: Identity, sha256: string) {
  const file = await open(path, "r+")
  try {
    await verify(file, path, identity, sha256)
    await file.truncate(0)
    await write(file, path, data)
  } finally {
    await file.close()
  }
}

export async function replaceChecked(path: string, data: Uint8Array, identity: Identity, sha256: string) {
  const approved = await open(path, "r+")
  try {
    await verify(approved, path, identity, sha256, "replaceFileChecked")
  } finally {
    await approved.close()
  }
  const id = randomUUID()
  const stage = join(dirname(path), `.raya-stage-${id}`)
  const hold = join(dirname(path), `.raya-replace-${id}`)
  const digest = createHash("sha256").update(data).digest("hex")
  await createChecked(stage, data)
  const staged = await stat(stage, { bigint: true })
  try {
    await rename(path, hold)
  } catch (cause) {
    await removeChecked(stage, { dev: staged.dev.toString(), ino: staged.ino.toString() }, digest)
    throw cause
  }
  try {
    const file = await open(hold, "r")
    const info = await (async () => {
      try {
        return await verify(file, path, identity, sha256, "replaceFileChecked")
      } finally {
        await file.close()
      }
    })()
    await chmod(stage, Number(info.mode & 0o777n))
  } catch (cause) {
    const restored = await restore(hold, path, cause).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const cleaned = await removeChecked(stage, { dev: staged.dev.toString(), ino: staged.ino.toString() }, digest).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!restored.ok || !cleaned.ok) {
      const errors = [cause, restored.ok ? undefined : restored.error, cleaned.ok ? undefined : cleaned.error].filter(
        (error) => error !== undefined,
      )
      throw Object.assign(new Error(`Checked replacement failed. Retained recovery files beside ${path}.`), {
        code: "ESTALE",
        path,
        syscall: "replaceFileChecked",
        cause: new AggregateError(errors),
      })
    }
    throw cause
  }
  try {
    await link(stage, path)
  } catch (cause) {
    const restored = await restore(hold, path, cause).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const cleaned = await removeChecked(stage, { dev: staged.dev.toString(), ino: staged.ino.toString() }, digest).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!restored.ok || !cleaned.ok) {
      const errors = [cause, restored.ok ? undefined : restored.error, cleaned.ok ? undefined : cleaned.error].filter(
        (error) => error !== undefined,
      )
      throw Object.assign(new Error(`Checked replacement was interrupted. Retained recovery files beside ${path}.`), {
        code: "ESTALE",
        path,
        syscall: "replaceFileChecked",
        cause: new AggregateError(errors),
      })
    }
    throw cause
  }
  const cleanup = await Promise.allSettled([unlink(stage), unlink(hold)])
  const failed = cleanup.filter((item): item is PromiseRejectedResult => item.status === "rejected")
  if (failed.length > 0) {
    throw Object.assign(new Error(`Checked replacement committed but retained recovery files beside ${path}.`), {
      code: "EIO",
      path,
      syscall: "replaceFileChecked",
      cause: new AggregateError(failed.map((item) => item.reason)),
    })
  }
}

export async function removeChecked(path: string, identity: Identity, sha256: string) {
  const hold = join(dirname(path), `.raya-remove-${randomUUID()}`)
  await rename(path, hold)
  try {
    const file = await open(hold, "r")
    try {
      await verify(file, path, identity, sha256, "removeFileChecked")
    } finally {
      await file.close()
    }
  } catch (cause) {
    await restore(hold, path, cause)
    throw cause
  }
  try {
    await unlink(hold)
  } catch (cause) {
    await restore(hold, path, cause)
    throw cause
  }
}
