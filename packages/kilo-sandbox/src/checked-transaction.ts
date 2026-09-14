import { createHash } from "node:crypto"
import { chmod, link, lstat, open, unlink } from "node:fs/promises"
import path from "node:path"
import { createAnchored, createChecked, type Identity } from "./checked-write"

export interface Proof {
  readonly identity: Identity
  readonly sha256: string
}

export interface Anchor {
  readonly path: string
  readonly identity: Identity
}

export interface Entry {
  readonly kind: "create" | "replace" | "remove"
  readonly target: string
  readonly stage?: string
  readonly hold?: string
  readonly review?: Proof
  readonly result?: { readonly sha256: string }
  readonly artifact?: Proof
  readonly anchor?: Anchor
}

interface State extends Proof {
  readonly mode: number
  readonly links: bigint
}

function error(entry: Entry, message: string) {
  return Object.assign(new Error(message), {
    code: "ESTALE",
    path: entry.target,
    syscall: "transactFileChecked",
  })
}

function missing(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
}

function equal(left: Identity, right: Identity) {
  return left.dev === right.dev && left.ino === right.ino
}

function exact(state: State | undefined, proof: Proof | undefined) {
  return Boolean(state && proof && equal(state.identity, proof.identity) && state.sha256 === proof.sha256)
}

function changed(state: State | undefined, proof: Proof | undefined) {
  return Boolean(state && proof && equal(state.identity, proof.identity) && state.sha256 !== proof.sha256)
}

async function inspect(target: string): Promise<State | undefined> {
  const before = await lstat(target, { bigint: true }).catch((cause) => {
    if (missing(cause)) return undefined
    throw cause
  })
  if (!before) return
  if (!before.isFile() || before.isSymbolicLink())
    throw Object.assign(new Error("Transaction path is not a regular file."), { code: "ESTALE", path: target })
  const file = await open(target, "r")
  try {
    const info = await file.stat({ bigint: true })
    if (info.dev !== before.dev || info.ino !== before.ino)
      throw Object.assign(new Error("Transaction path changed during inspection."), { code: "ESTALE", path: target })
    const data = await file.readFile()
    const after = await lstat(target, { bigint: true })
    if (after.dev !== info.dev || after.ino !== info.ino)
      throw Object.assign(new Error("Transaction path changed during inspection."), { code: "ESTALE", path: target })
    return {
      identity: { dev: info.dev.toString(), ino: info.ino.toString() },
      sha256: createHash("sha256").update(data).digest("hex"),
      mode: Number(info.mode & 0o777n),
      links: info.nlink,
    }
  } finally {
    await file.close()
  }
}

function paths(entry: Entry) {
  if (!path.isAbsolute(entry.target)) throw error(entry, "Transaction target must be absolute.")
  for (const sidecar of [entry.stage, entry.hold]) {
    if (!sidecar) continue
    if (!path.isAbsolute(sidecar) || path.dirname(sidecar) !== path.dirname(entry.target))
      throw error(entry, "Transaction sidecars must remain beside their target.")
    if (!path.basename(sidecar).startsWith(".raya-txn-") || sidecar === entry.target)
      throw error(entry, "Transaction sidecar name is invalid.")
  }
  if (entry.stage && entry.hold && entry.stage === entry.hold)
    throw error(entry, "Transaction stage and hold must be distinct.")
}

function requireProof(entry: Entry, proof: Proof | undefined, label: string): asserts proof is Proof {
  if (!proof) throw error(entry, `Transaction ${label} proof is missing.`)
}

function requirePath(entry: Entry, target: string | undefined, label: string): asserts target is string {
  if (!target) throw error(entry, `Transaction ${label} path is missing.`)
}

async function writable(entry: Entry) {
  const file = await open(entry.target, "r+")
  await file.close()
}

export async function stage(entry: Entry, data: Uint8Array): Promise<Proof> {
  paths(entry)
  requirePath(entry, entry.stage, "stage")
  if (entry.kind === "create") {
    if (!entry.anchor) throw error(entry, "Transaction create anchor is missing.")
    await createAnchored(entry.stage, data, entry.anchor.path, entry.anchor.identity)
  } else {
    await createChecked(entry.stage, data)
  }
  const state = await inspect(entry.stage)
  if (!state || state.links !== 1n) throw error(entry, "Transaction stage could not be verified.")
  return { identity: state.identity, sha256: state.sha256 }
}

async function create(entry: Entry) {
  requirePath(entry, entry.stage, "stage")
  requireProof(entry, entry.artifact, "stage")
  const staged = await inspect(entry.stage)
  if (!exact(staged, entry.artifact) || (staged!.links !== 1n && staged!.links !== 2n))
    throw error(entry, "Transaction stage changed before publication.")
  const target = await inspect(entry.target)
  if (!target) {
    if (staged!.links !== 1n) throw error(entry, "Transaction stage changed before publication.")
    await link(entry.stage, entry.target)
    return
  }
  if (exact(target, entry.artifact) && equal(target.identity, staged!.identity) && staged!.links === 2n) return
  throw error(entry, "Transaction create target is owned by another writer.")
}

async function replace(entry: Entry) {
  requirePath(entry, entry.stage, "stage")
  requirePath(entry, entry.hold, "hold")
  requireProof(entry, entry.review, "review")
  requireProof(entry, entry.artifact, "stage")
  const staged = await inspect(entry.stage)
  if (!exact(staged, entry.artifact) || (staged!.links !== 1n && staged!.links !== 2n))
    throw error(entry, "Transaction stage changed before replacement.")
  let hold = await inspect(entry.hold)
  let target = await inspect(entry.target)
  if (!hold) {
    if (!exact(target, entry.review) || target!.links !== 1n)
      throw error(entry, "Reviewed target changed before displacement.")
    await writable(entry)
    await link(entry.target, entry.hold)
    hold = await inspect(entry.hold)
    target = await inspect(entry.target)
  }
  if (!exact(hold, entry.review) || (hold!.links !== 1n && hold!.links !== 2n))
    throw error(entry, "Displaced target changed before publication.")
  await chmod(entry.stage, hold!.mode)
  if (target && exact(target, entry.review) && equal(target.identity, hold!.identity)) {
    if (target.links !== 2n) throw error(entry, "Displacement link count is invalid.")
    await unlink(entry.target)
    target = undefined
  }
  if (!target) {
    if (staged!.links !== 1n) throw error(entry, "Transaction stage changed before replacement.")
    await link(entry.stage, entry.target)
    return
  }
  if (exact(target, entry.artifact) && equal(target.identity, staged!.identity) && staged!.links === 2n) return
  throw error(entry, "Replacement target is owned by another writer.")
}

async function remove(entry: Entry) {
  requirePath(entry, entry.hold, "hold")
  requireProof(entry, entry.review, "review")
  let hold = await inspect(entry.hold)
  let target = await inspect(entry.target)
  if (!hold) {
    if (!exact(target, entry.review) || target!.links !== 1n)
      throw error(entry, "Reviewed target changed before removal.")
    await link(entry.target, entry.hold)
    hold = await inspect(entry.hold)
    target = await inspect(entry.target)
  }
  if (!exact(hold, entry.review) || (hold!.links !== 1n && hold!.links !== 2n))
    throw error(entry, "Displaced target changed before removal.")
  if (!target) return
  if (!exact(target, entry.review) || !equal(target.identity, hold!.identity) || target.links !== 2n)
    throw error(entry, "Removal target is owned by another writer.")
  await unlink(entry.target)
}

export async function commit(entry: Entry) {
  paths(entry)
  if (entry.kind === "create") return create(entry)
  if (entry.kind === "replace") return replace(entry)
  return remove(entry)
}

async function restore(entry: Entry) {
  requirePath(entry, entry.hold, "hold")
  requireProof(entry, entry.review, "review")
  const hold = await inspect(entry.hold)
  let target = await inspect(entry.target)
  if (!hold) {
    if (exact(target, entry.review)) return
    throw error(entry, "Transaction preimage is unavailable for rollback.")
  }
  if (!exact(hold, entry.review) && !changed(hold, entry.review))
    throw error(entry, "Transaction hold is owned by another writer.")
  if (target && entry.artifact && exact(target, entry.artifact)) {
    await unlink(entry.target)
    target = undefined
  }
  if (target && equal(target.identity, hold.identity)) {
    await unlink(entry.hold)
    return
  }
  if (target) throw error(entry, "Rollback target contains newer user work; retained recovery files.")
  await link(entry.hold, entry.target)
  await unlink(entry.hold)
}

export async function rollback(entry: Entry) {
  paths(entry)
  if (entry.kind !== "create") return restore(entry)
  requireProof(entry, entry.artifact, "stage")
  const target = await inspect(entry.target)
  if (!target) return
  if (!exact(target, entry.artifact))
    throw error(entry, "Rollback target contains newer user work; retained the transaction stage.")
  await unlink(entry.target)
}

async function discard(entry: Entry, target: string | undefined, proof: Proof | undefined) {
  if (!target || !proof) return
  const state = await inspect(target)
  if (!state) return
  if (!exact(state, proof)) throw error(entry, `Transaction recovery file changed at ${target}.`)
  await unlink(target)
}

export async function cleanup(entry: Entry, committed: boolean) {
  paths(entry)
  const target = await inspect(entry.target)
  if (committed) {
    if (entry.kind === "remove") {
      if (target) throw error(entry, "Removed target was recreated before cleanup.")
      const hold = await inspect(entry.hold!)
      if (changed(hold, entry.review)) {
        await link(entry.hold!, entry.target)
        await unlink(entry.hold!)
        throw error(entry, "The displaced file changed after removal and was restored.")
      }
      await discard(entry, entry.hold, entry.review)
      return
    }
    requireProof(entry, entry.artifact, "stage")
    if (!exact(target, entry.artifact)) throw error(entry, "Committed target changed before cleanup.")
    if (entry.kind === "replace") {
      const hold = await inspect(entry.hold!)
      if (changed(hold, entry.review)) {
        await unlink(entry.target)
        await link(entry.hold!, entry.target)
        await unlink(entry.hold!)
        await discard(entry, entry.stage, entry.artifact)
        throw error(entry, "The displaced file changed after replacement and was restored.")
      }
    }
    await discard(entry, entry.stage, entry.artifact)
    if (entry.kind === "replace") await discard(entry, entry.hold, entry.review)
    return
  }
  if (entry.kind === "create") {
    if (target) throw error(entry, "Rolled-back create target was recreated before cleanup.")
  } else {
    requireProof(entry, entry.review, "review")
    if (!exact(target, entry.review) && !changed(target, entry.review))
      throw error(entry, "Rolled-back target changed before cleanup.")
  }
  await discard(entry, entry.stage, entry.artifact)
  await discard(entry, entry.hold, entry.review)
}
