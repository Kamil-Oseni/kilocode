import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { check } from "../control/frames"
import { fingerprint } from "../failed-repair"
import { parse } from "../settings"
import type { review } from "../committed-capture"
import { descriptor, type Descriptor } from "./descriptor"
import { inspect } from "./upgrade-publish"
import { lineage } from "./upgrade-lineage"

type Review = Awaited<ReturnType<typeof review>>
type Storage = { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
type Entry = { setup: unknown; credential: string; managed?: Descriptor; launch?: unknown }
type Link = Readonly<{
  format: "raya.memory.committed-capture.upgrade"
  version: 1
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
}>
const selections = new WeakMap<object, { link: Link; selectionSHA: string }>()
const state = "raya.secondBrain.setup"

export function origin(storage: Storage, previous: Entry, value: Review) {
  const key = `raya.secondBrain.committedCaptureRecovery.${value.capture}`
  const audit = storage.get<Record<string, unknown>>(key)
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
export async function associate(storage: Storage, previous: Entry, current: Entry, value: Review) {
  const before = parse(previous.setup)
  const after = parse(current.setup)
  const cfg = descriptor(current.managed)
  const folder = path.dirname(cfg.supervisor.path)
  const id = path.basename(folder).slice("raya-memory-source-upgrade-".length)
  check(
    /^[a-f0-9]{32}$/.test(id) &&
      folder === path.join(cfg.root, "raya-memory-source-upgrade-" + id) &&
      cfg.supervisor.path === path.join(folder, "supervise.py") &&
      current.credential === previous.credential &&
      before.root === after.root &&
      after.root === value.root,
    "Original capture upgrade selection differs",
  )
  const { key, audit, evidence } = origin(storage, previous, value)
  const retained = storage.get<{ artifact: Descriptor["plan"] }>(`raya.secondBrain.runtimeUpgrade.${id}`)
  check(retained?.artifact, "Applied original capture runtime upgrade required")
  const upgrade = await inspect(storage, retained.artifact)
  check(previous.launch && typeof previous.launch === "object", "Original capture launch required")
  const closed = { ...previous, launch: { ...previous.launch, phase: "closed", receipt: value.closure.closed } }
  check(
    isDeepStrictEqual(upgrade.saved, closed) &&
      isDeepStrictEqual(upgrade.next.setup, after) &&
      upgrade.next.managed.root === cfg.root,
    "Applied upgrade does not derive from the original recovered capture",
  )
  await lineage(upgrade.next.managed, after, cfg, current.launch)
  check(
    isDeepStrictEqual(storage.get(state), current) && isDeepStrictEqual(storage.get(key), audit),
    "Original capture upgrade changed during native review",
  )
  const link: Link = Object.freeze({
    format: "raya.memory.committed-capture.upgrade",
    version: 1,
    capture: value.capture,
    artifact: upgrade.receipt,
    previousRelease: fingerprint(before.source_sha256),
    release: fingerprint(after.source_sha256),
    recoverySHA: fingerprint(audit),
    publicationSHA: fingerprint(upgrade.publication),
    reviewSHA: fingerprint(evidence),
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  })
  selections.set(value, { link, selectionSHA: fingerprint(current) })
  return value
}

/** Persisted JSON alone cannot authorize a cross-release confirmation. */
export function linked(value: Review, storage?: Storage) {
  const selected = selections.get(value)
  if (!selected) return undefined
  if (storage)
    check(
      fingerprint(storage.get(state)) === selected.selectionSHA &&
        storage.get("raya.secondBrain.committedCaptureRecovery.pending") === undefined &&
        storage.get("raya.secondBrain.control.uncertainty") === undefined,
      "Reviewed capture upgrade selection changed",
    )
  return selected.link
}
