import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { image } from "./control/identity"
import { receipt } from "./managed/descriptor"
import { review as closed, absent } from "./closed-recovery"
import { parse } from "./settings"
import { fingerprint } from "./failed-repair"
import { records } from "./capture-intake"

type Storage = { get<T>(key: string): T | undefined }
const setup = "raya.secondBrain.setup"
const ledger = "raya.secondBrain.personalCapture.turns"
const failures = "raya.secondBrain.personalCapture.failures"
const debt = "raya.secondBrain.control.uncertainty"

function clean(input: unknown, id: string) {
  return input === undefined || (Array.isArray(input) && !input.some((row) => object(row).id === id))
}

/** Reserved is pre-publication: the host awaits durable saving before invoking capture control. */
export async function review(id: string, storage: Storage, extension: string) {
  const state = structuredClone(storage.get<unknown>(setup))
  const entry = object(state as Parameters<typeof object>[0])
  const selected = parse(entry.setup)
  const launch = object(entry.launch)
  const saved = records(storage.get(ledger))
  const diagnostics = structuredClone(storage.get<unknown>(failures))
  const audit = storage.get<{ phase?: string; original?: unknown; completed?: unknown }>(
    `raya.secondBrain.captureReservation.${id}`,
  )
  const current = saved.find((row) => row.id === id)
  const original = audit ? records([audit.original])[0] : current
  check(
    original &&
      original.id === id &&
      original.phase === "reserved" &&
      original.receipt === undefined &&
      selected.version === 2 &&
      original.root === selected.root &&
      original.release === fingerprint(selected.source_sha256) &&
      launch.phase === "closed",
    "Original reserved capture and exact current closed release required",
  )
  const completed = { ...original, phase: "skipped" as const }
  check(
    isDeepStrictEqual(current, original) ||
      (audit &&
        ["prepared", "applied"].includes(String(audit.phase)) &&
        isDeepStrictEqual(audit.completed, completed) &&
        isDeepStrictEqual(current, completed)),
    "Original reservation is no longer an untouched pre-publication attempt",
  )
  check(
    clean(diagnostics, id) && storage.get(debt) === undefined,
    "Capture diagnostics or request debt cannot be abandoned as a reservation",
  )
  const ref = receipt(launch.receipt)
  const held = await image(ref.path, 65536)
  check(
    held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
    "Original closure image changed",
  )
  const value = object(document(held.raw, 65536).value)
  // Derive the running receipt from the genuine closed image, never caller-authored owner metadata.
  const closure = await closed({
    setup: entry.setup,
    managed: entry.managed,
    launch: { phase: "running", receipt: value.original },
  })
  check(isDeepStrictEqual(closure.closed, ref), "Current closure differs from the original paired shutdown")
  const observation = await absent(closure, extension)
  check(
    isDeepStrictEqual(storage.get(setup), state) &&
      isDeepStrictEqual(records(storage.get(ledger)), saved) &&
      isDeepStrictEqual(storage.get(failures), diagnostics) &&
      storage.get(debt) === undefined,
    "Original reservation, selection or debt changed during review",
  )
  return {
    format: "raya.capture.reservation.abandonment" as const,
    version: 1 as const,
    original,
    completed,
    bindingSHA: fingerprint(state),
    ledgerSHA: fingerprint({ turns: saved.map((row) => (row.id === id ? original : row)) }),
    failuresSHA: fingerprint({ failures: diagnostics }),
    closure,
    observation,
    qualification:
      "Abandon only a reserved attempt under the exact closed current owner; no saved facts or historical transport settlement authority",
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  }
}
