import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { check, sha } from "../control/frames"
import { parseCatalog } from "../control/catalog"
import { fingerprint } from "../failed-repair"
import { absent } from "../failed-archive"
import { parse } from "../settings"
import { records, migrate } from "../capture-intake"
import { descriptor, selection, type Descriptor } from "./descriptor"
import { launch } from "./restart"
import { review } from "./upgrade-review"

type Storage = { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
type Entry = { setup: unknown; credential: string; managed: Descriptor; launch?: unknown }
type Slot = { present: false } | { present: true; value: unknown }
const keys = ["raya.secondBrain.setup", "raya.secondBrain.control.catalog", "raya.secondBrain.personalCapture"] as const
const pending = "raya.secondBrain.committedCaptureRecovery.pending"
const ledger = "raya.secondBrain.personalCapture.turns"
type Audit = {
  format: "raya.memory.runtime.upgrade.publication"
  version: 1
  id: string
  artifact: Descriptor["plan"]
  previous: Slot[]
  next: Slot[]
  reviewSHA: string
  ledgerSHA: string
  phase: "prepared" | "applied"
  stage: number
  requestSettlement: false
  replay: false
  indexConfirmed: false
}
type Marker = { format: "raya.memory.runtime.upgrade.pending"; version: 1; audit: Audit }

function entry(input: unknown): Entry {
  check(input && typeof input === "object" && !Array.isArray(input), "Existing upgrade setup required")
  const value = input as Record<string, unknown>
  check(
    ["credential,managed,setup", "credential,launch,managed,setup"].includes(Object.keys(value).sort().join()) &&
      typeof value.credential === "string" &&
      /^raya\.secondBrain\.key\.[a-f0-9-]{36}$/.test(value.credential),
    "Exact existing upgrade credential reference required",
  )
  return {
    setup: parse(value.setup),
    credential: value.credential,
    managed: descriptor(value.managed),
    ...(value.launch === undefined ? {} : { launch: value.launch }),
  }
}

function slots(storage: Storage) {
  return keys.map((key) => slot(storage.get(key)))
}

function slot(value: unknown): Slot {
  return value === undefined ? { present: false } : { present: true, value: structuredClone(value) }
}

function value(input: Slot): unknown {
  check(input && typeof input === "object", "Retained upgrade slot required")
  check(
    isDeepStrictEqual(input, input.present === false ? { present: false } : { present: true, value: input.value }) &&
      (input.present === false || (input.present === true && input.value !== undefined)),
    "Exact persisted upgrade slot required",
  )
  return input.present ? input.value : undefined
}

function digest(storage: Storage) {
  // The bounded strict ledger has strings only; retain every original row/order without a small document-size limit.
  return sha(JSON.stringify(records(storage.get(ledger))))
}

function prefix(values: Slot[], audit: Audit) {
  for (const stage of [3, 2, 1, 0])
    if (
      values.every((value, index) =>
        isDeepStrictEqual(value, index < stage ? audit.next[index] : audit.previous[index]),
      )
    )
      return stage
  throw new Error("Runtime upgrade has foreign or nonsequential saved state")
}

function same(audit: Audit, input: unknown) {
  check(input && typeof input === "object" && !Array.isArray(input), "Retained upgrade publication required")
  const value = input as Audit
  check(
    ["prepared", "applied"].includes(value.phase) &&
      Number.isSafeInteger(value.stage) &&
      value.stage >= 0 &&
      value.stage <= 3 &&
      (value.phase !== "applied" || value.stage === 3) &&
      isDeepStrictEqual(value, { ...audit, phase: value.phase, stage: value.stage }),
    "Retained runtime upgrade publication differs",
  )
  return value
}

async function admission(previous: Entry) {
  if (previous.launch !== undefined) {
    check(
      previous.launch && typeof previous.launch === "object" && !Array.isArray(previous.launch),
      "Retained closed upgrade launch required",
    )
    const value = previous.launch as Record<string, unknown>
    check(value.phase === "closed", "Runtime upgrade requires an unstarted or genuinely closed pair")
    await launch(previous.managed, parse(previous.setup), value.receipt)
  }
  const selected = await selection(previous.managed, parse(previous.setup))
  const env = selected.plan.env as Record<string, unknown>
  const ports = [Number(new URL(parse(previous.setup).origin).port), Number(env.RAYA_RETRIEVAL_PORT)]
  check(
    ports.every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535) && ports[0] !== ports[1],
    "Exact original upgrade ports required",
  )
  return absent({ pids: [], ports })
}

function catalog(input: unknown, proof: Awaited<ReturnType<typeof review>>) {
  if (input === undefined) return undefined
  check(input && typeof input === "object" && !Array.isArray(input), "Retained control selection required")
  const selected = input as Record<string, unknown>
  check(
    Object.keys(selected).sort().join() === "catalog,root" &&
      selected.root === proof.previous.setup.root &&
      selected.root === proof.next.setup.root,
    "Retained control notes root differs",
  )
  const value = parseCatalog(selected.catalog)
  check(
    isDeepStrictEqual(value.source_sha256, proof.previous.setup.source_sha256) &&
      proof.original.length > 0 &&
      proof.original.every((item) => path.resolve(path.dirname(item.path)) === path.resolve(value.source)),
    "Original control release differs",
  )
  // Original Python/bridge execution images stay selected; only the reviewed source directory/release changes.
  return {
    root: selected.root,
    catalog: parseCatalog({ ...value, source: proof.source, source_sha256: proof.next.setup.source_sha256 }),
  }
}

function intent(storage: Storage, artifact: Descriptor["plan"]) {
  const id = path.basename(path.dirname(artifact.path)).slice("raya-memory-fresh-".length)
  check(
    /^[a-f0-9]{32}$/.test(id) &&
      path.basename(artifact.path) === "upgrade-prepared.json" &&
      path.basename(path.dirname(artifact.path)) === "raya-memory-fresh-" + id,
    "Exact immutable upgrade publication location required",
  )
  const key = `raya.secondBrain.runtimeUpgrade.${id}`
  const held = storage.get<Marker>(pending)
  check(
    held === undefined ||
      (held.format === "raya.memory.runtime.upgrade.pending" &&
        held.version === 1 &&
        held.audit &&
        isDeepStrictEqual(held.audit.artifact, artifact)),
    "Another Memory recovery or upgrade remains active",
  )
  const retained = storage.get<Audit>(key)
  if (retained) check(isDeepStrictEqual(retained.artifact, artifact), "Retained upgrade artifact differs")
  const original = held?.audit.previous ?? retained?.previous ?? slots(storage)
  check(Array.isArray(original) && original.length === keys.length, "Exact original upgrade slots required")
  original.forEach(value)
  return { id, key, held, retained, original }
}

async function apply(
  storage: Storage,
  key: string,
  audit: Audit,
  marker: Marker,
  current: number,
  verify: () => number,
) {
  for (const stage of [0, 1, 2]) {
    if (stage < current) continue
    check(
      verify() >= stage && isDeepStrictEqual(storage.get(pending), marker),
      "Runtime publication checkpoint changed",
    )
    await storage.update(keys[stage], value(audit.next[stage]))
    check(verify() >= stage + 1, "Runtime publication physical readback differs")
    await storage.update(key, { ...audit, stage: stage + 1 })
    const checkpoint = same(audit, storage.get(key))
    check(checkpoint.stage === stage + 1, "Runtime publication audit checkpoint differs")
  }
  const applied: Audit = { ...audit, phase: "applied", stage: 3 }
  check(verify() === 3, "Runtime publication is incomplete")
  await storage.update(key, applied)
  check(isDeepStrictEqual(storage.get(key), applied) && verify() === 3, "Runtime upgrade applied audit changed")
  await storage.update(pending, undefined)
  check(storage.get(pending) === undefined && verify() === 3, "Runtime upgrade fence clearance changed")
  return applied
}

async function preparation(storage: Storage, artifact: Descriptor["plan"]) {
  const { id, key, held, retained, original } = intent(storage, artifact)
  const previous = entry(value(original[0]))
  const proof = await review(artifact, { setup: parse(previous.setup), managed: previous.managed })
  check(proof.id === id, "Original runtime publication selection differs")
  const selected = previous
  check(
    storage.get("raya.secondBrain.control.uncertainty") === undefined,
    "Original uncertainty must be recovered before runtime upgrade",
  )
  const next = { setup: proof.next.setup, managed: proof.next.managed, credential: selected.credential }
  const audit: Audit = {
    format: "raya.memory.runtime.upgrade.publication",
    version: 1,
    id: proof.id,
    artifact: proof.receipt,
    previous: original,
    next: [
      next,
      catalog(value(original[1]), proof),
      migrate(value(original[2]), parse(selected.setup), proof.next.setup),
    ].map(slot),
    reviewSHA: proof.reviewSHA,
    ledgerSHA: held?.audit.ledgerSHA ?? retained?.ledgerSHA ?? digest(storage),
    phase: "prepared",
    stage: 0,
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  }
  if (original[2].present && !original[1].present)
    throw new Error("Automatic saving requires its retained control catalog")
  check(/^[a-f0-9]{64}$/.test(audit.ledgerSHA), "Original capture ledger digest required")
  const marker: Marker = { format: "raya.memory.runtime.upgrade.pending", version: 1, audit }
  if (held) check(isDeepStrictEqual(held, marker), "Retained upgrade fence differs")
  if (retained) same(audit, retained)
  return { key, held, retained, selected, proof, audit, marker }
}

/** Fresh native review of an applied publication does not mutate settings or claim the index is ready. */
export async function inspect(storage: Storage, artifact: Descriptor["plan"]) {
  const value = await preparation(storage, artifact)
  check(
    value.retained?.phase === "applied" &&
      value.retained.stage === 3 &&
      storage.get(pending) === undefined &&
      isDeepStrictEqual(storage.get(value.key), value.retained),
    "Applied runtime publication and cleared startup fence required",
  )
  return Object.freeze({ ...value.proof, publication: value.retained, saved: value.selected })
}

/** Prefix publication is resumable after physical-write/ack loss. An unresolved fence remains; no rollback overwrites foreign state. */
export async function publish(storage: Storage, artifact: Descriptor["plan"]) {
  const { key, held, retained, selected, proof, audit, marker } = await preparation(storage, artifact)
  const verify = () => {
    check(
      storage.get("raya.secondBrain.control.uncertainty") === undefined && digest(storage) === audit.ledgerSHA,
      "Original capture history or uncertainty changed during upgrade",
    )
    check(
      storage.get(pending) === undefined || isDeepStrictEqual(storage.get(pending), marker),
      "Runtime upgrade fence changed",
    )
    return prefix(slots(storage), audit)
  }
  const current = verify()
  if (retained?.phase === "applied") {
    check(current === 3, "Applied runtime upgrade state differs")
    if (held) await storage.update(pending, undefined)
    check(storage.get(pending) === undefined && verify() === 3, "Applied runtime upgrade fence clearance changed")
    return Object.freeze({ ...proof, publication: retained })
  }
  check(!retained || current >= retained.stage, "Runtime upgrade publication moved backwards")
  await admission(selected)
  check(verify() === current, "Runtime upgrade selection changed during admission")
  // The fence carries the complete original intent, so a cold host can recover even before the audit key is written.
  await storage.update(pending, marker)
  check(
    isDeepStrictEqual(storage.get(pending), marker) && verify() === current,
    "Runtime upgrade fence publication changed",
  )
  if (!retained) await storage.update(key, audit)
  same(audit, storage.get(key))
  const applied = await apply(storage, key, audit, marker, current, verify)
  return Object.freeze({ ...proof, publication: applied })
}
