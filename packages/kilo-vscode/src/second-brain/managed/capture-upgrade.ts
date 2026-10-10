import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { check } from "../control/frames"
import { fingerprint } from "../failed-repair"
import { parse } from "../settings"
import type { review } from "../committed-capture"
import { descriptor, type Descriptor } from "./descriptor"
import { anchor, guard, inspect, inspectAncestor } from "./upgrade-publish"
import { lineage } from "./upgrade-lineage"
import { successors } from "./capture-lineage"
import { freshHistory } from "../capture-revisions"

type Review = Awaited<ReturnType<typeof review>>
type Storage = { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
type Entry = { setup: unknown; credential: string; managed?: Descriptor; launch?: unknown }
type Edge = Readonly<{ artifact: Descriptor["plan"]; publicationSHA: string; reviewSHA: string }>
type Upgrade = Awaited<ReturnType<typeof inspect>>
type Grant = Awaited<ReturnType<typeof anchor>>
type Link = Readonly<{
  format: "raya.memory.committed-capture.upgrade"
  capture: string
  artifact: Descriptor["plan"]
  previousRelease: string
  release: string
  recoverySHA: string
  publicationSHA: string
  reviewSHA: string
  requestSettlement: false
  replay: false
  indexConfirmed: false
}> &
  ({ readonly version: 1 } | { readonly version: 2; readonly chain: readonly Edge[] })
const selections = new WeakMap<
  object,
  {
    link?: Link
    selectionSHA: string
    audits: readonly { key: string; audit: unknown }[]
    prefixes: readonly Link[]
    verify: () => void
    refresh: () => Promise<void>
  }
>()
const ancestors = new WeakMap<object, { prefixes: readonly Link[]; verify: () => void }>()
const state = "raya.secondBrain.setup"

function identity(cfg: Descriptor) {
  const folder = path.dirname(cfg.supervisor.path)
  const id = path.basename(folder).slice("raya-memory-source-upgrade-".length)
  check(
    /^[a-f0-9]{32}$/.test(id) &&
      folder === path.join(cfg.root, "raya-memory-source-upgrade-" + id) &&
      cfg.supervisor.path === path.join(folder, "supervise.py"),
    "Original capture upgrade selection differs",
  )
  return id
}

function inactive(input: unknown) {
  return (
    input === undefined || (typeof input === "object" && input !== null && "phase" in input && input.phase === "closed")
  )
}

function proof(chain: readonly Upgrade[], capture: string, release: string, audit: unknown, evidence: unknown): Link {
  const upgrade = chain[chain.length - 1]
  return Object.freeze({
    format: "raya.memory.committed-capture.upgrade",
    ...(chain.length === 1
      ? { version: 1 as const }
      : {
          version: 2 as const,
          chain: Object.freeze(
            chain.map((row) =>
              Object.freeze({
                artifact: row.receipt,
                publicationSHA: fingerprint(row.publication),
                reviewSHA: row.reviewSHA,
              }),
            ),
          ),
        }),
    capture,
    artifact: upgrade.receipt,
    previousRelease: release,
    release: fingerprint(upgrade.next.setup.source_sha256),
    recoverySHA: fingerprint(audit),
    publicationSHA: fingerprint(upgrade.publication),
    reviewSHA: fingerprint(evidence),
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  })
}

export function origin(storage: Storage, previous: Entry, value: Review) {
  const key = `raya.secondBrain.committedCaptureRecovery.${value.capture}`
  const audit = structuredClone(storage.get<Record<string, unknown>>(key))
  const { producer, ...evidence } = value
  check(
    producer.code === 0 &&
      producer.originalJoined &&
      producer.readersJoined &&
      audit?.format === "raya.memory.committed-capture.recovery" &&
      audit.version === 1 &&
      audit.phase === "applied" &&
      audit.requestSettlement === false &&
      audit.replay === false &&
      audit.indexConfirmed === false &&
      isDeepStrictEqual(audit.previous, previous) &&
      isDeepStrictEqual(audit.review, evidence) &&
      audit.reviewSHA === fingerprint(evidence) &&
      value.entrySHA === fingerprint(previous),
    "Original applied capture recovery linkage differs",
  )
  return { key, audit, evidence }
}

/** Link only a fresh original-effect review to an exact applied upgrade and verified current successor lineage. */
async function walk(storage: Storage, previous: Entry, current: Entry, value: Review, grant?: Grant) {
  previous = structuredClone(previous)
  current = structuredClone(current)
  const before = parse(previous.setup)
  const after = parse(current.setup)
  const cfg = descriptor(current.managed)
  check(
    current.credential === previous.credential && before.root === after.root && after.root === value.root,
    "Original capture upgrade selection differs",
  )
  const { key, audit, evidence } = origin(storage, previous, value)
  check(previous.launch && typeof previous.launch === "object", "Original capture launch required")
  const closure = structuredClone(value.closure.closed)
  const chain: Upgrade[] = []
  const held: { key: string; audit: unknown }[] = []
  const verify = () => {
    if (grant) guard(storage, grant)
    check(
      (grant || isDeepStrictEqual(storage.get(state), current)) &&
        isDeepStrictEqual(storage.get(key), audit) &&
        held.every((row) => isDeepStrictEqual(storage.get(row.key), row.audit)),
      "Original capture upgrade changed during native review",
    )
  }
  verify()
  const ids = new Set<string>()
  let entry = current
  for (;;) {
    if (isDeepStrictEqual(parse(entry.setup), before)) {
      await successors(previous, entry, closure)
      verify()
      break
    }
    check(chain.length < 32, "Original capture upgrade chain exceeds its bound")
    const id = identity(descriptor(entry.managed))
    check(!ids.has(id), "Original capture upgrade chain repeats an edge")
    ids.add(id)
    const key = `raya.secondBrain.runtimeUpgrade.${id}`
    const retained = structuredClone(storage.get<{ artifact: Descriptor["plan"] }>(key))
    check(retained?.artifact, "Applied original capture runtime upgrade required")
    held.push({ key, audit: retained })
    const upgrade = grant
      ? await inspectAncestor(storage, retained.artifact, grant)
      : await inspect(storage, retained.artifact)
    verify()
    check(upgrade.id === id, "Original capture upgrade artifact identity differs")
    chain.push(upgrade)
    entry = upgrade.saved
  }
  chain.reverse()
  for (const [index, upgrade] of chain.entries()) {
    const successor = chain[index + 1]
    const entry = successor ? successor.saved : current
    const setup = parse(entry.setup)
    const managed = descriptor(entry.managed)
    check(
      isDeepStrictEqual(upgrade.next.setup, setup) &&
        upgrade.saved.credential === previous.credential &&
        entry.credential === previous.credential &&
        upgrade.next.managed.root === cfg.root &&
        managed.root === cfg.root &&
        isDeepStrictEqual(upgrade.next.managed.notes, cfg.notes) &&
        isDeepStrictEqual(upgrade.next.managed.python, cfg.python) &&
        (!successor || inactive(entry.launch)),
      "Applied upgrade does not derive from the original recovered capture",
    )
    await lineage(upgrade.next.managed, setup, managed, entry.launch)
    verify()
  }
  verify()
  const prefixes = Object.freeze(
    chain.map((_, index) =>
      proof(chain.slice(0, index + 1), value.capture, fingerprint(before.source_sha256), audit, evidence),
    ),
  )
  const refresh = async () => {
    verify()
    const refreshed = await walk(storage, previous, current, value, grant)
    verify()
    check(
      isDeepStrictEqual(refreshed.prefixes, prefixes) &&
        refreshed.selectionSHA === fingerprint(current) &&
        isDeepStrictEqual(refreshed.audits, [{ key, audit }, ...held]),
      "Original capture native binding changed during refresh",
    )
  }
  return { prefixes, selectionSHA: fingerprint(current), audits: [{ key, audit }, ...held], verify, refresh }
}

/** Link only a fresh original-effect review to applied upgrades and verified current successor lineage. */
export async function associate(storage: Storage, previous: Entry, current: Entry, value: Review) {
  const selected = await walk(storage, previous, current, value)
  const link = selected.prefixes[selected.prefixes.length - 1]
  selections.set(value, { ...selected, link })
  return value
}

/** Pending ancestors validate historical input only; they grant no intake or successor authority. */
export async function ancestry(storage: Storage, previous: Entry, value: Review, grant: Grant) {
  guard(storage, grant)
  check(!selections.has(value), "Fresh pending ancestor capture review required")
  const selected = await walk(storage, previous, grant.saved, value, grant)
  guard(storage, grant)
  ancestors.set(value, { prefixes: selected.prefixes, verify: selected.verify })
  return value
}

/** An older confirmation must match an exact prefix of this fresh native anchored chain. */
export function historical(value: Review, input: unknown) {
  const selected = selections.get(value) ?? ancestors.get(value)
  check(selected, "Fresh original capture chain and confirmation required")
  selected.verify()
  if (input === undefined) return undefined
  const prefix = selected.prefixes.find((row) => isDeepStrictEqual(row, input))
  check(prefix, "Original capture confirmation upgrade prefix differs")
  return structuredClone(prefix)
}

/** Persisted JSON alone cannot authorize a cross-release confirmation. */
export function linked(value: Review, storage?: Storage) {
  if (storage) check(!ancestors.has(value), "Pending capture ancestor cannot authorize confirmation")
  const selected = selections.get(value)
  if (!selected) return undefined
  if (storage)
    check(
      fingerprint(storage.get(state)) === selected.selectionSHA &&
        selected.audits.every((row) => isDeepStrictEqual(storage.get(row.key), row.audit)) &&
        storage.get("raya.secondBrain.committedCaptureRecovery.pending") === undefined &&
        storage.get("raya.secondBrain.control.uncertainty") === undefined,
      "Reviewed capture upgrade selection changed",
    )
  return structuredClone(selected.link)
}

/** Recheck native anchored receipt/image evidence around capture confirmation effects. */
export async function fresh(value: Review, storage: Storage) {
  linked(value, storage)
  await freshHistory(value)
  linked(value, storage)
  const selected = selections.get(value)
  if (!selected) return
  await selected.refresh()
  linked(value, storage)
  await freshHistory(value)
  linked(value, storage)
}
