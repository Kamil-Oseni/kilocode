import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { image } from "./control/identity"
import { receipt } from "./managed/descriptor"
import { review as closed, absent } from "./closed-recovery"
import { parse } from "./settings"
import { fingerprint } from "./failed-repair"
import { records } from "./capture-intake"
import { z } from "zod"

type Storage = { get<T>(key: string): T | undefined }
const setup = "raya.secondBrain.setup"
const ledger = "raya.secondBrain.personalCapture.turns"
const failures = "raya.secondBrain.personalCapture.failures"
const debt = "raya.secondBrain.control.uncertainty"
const failure = z
  .object({
    format: z.literal("raya.capture.extraction.failure"),
    version: z.literal(1),
    original: z.unknown(),
    completed: z.unknown(),
    reason: z.enum([
      "duplicate_key",
      "secret_text",
      "restricted_key",
      "invalid_schema",
      "extraction_failed",
      "source_changed",
      "grant_expired",
      "cancelled",
    ]),
    grantSHA: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.string().min(1),
    ledgerSHA: z.string().regex(/^[a-f0-9]{64}$/),
    failuresSHA: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.literal("prepared"),
    requestSettlement: z.literal(false),
    indexConfirmed: z.literal(false),
    replay: z.literal(false),
  })
  .strict()

function clean(input: unknown, id: string) {
  return input === undefined || (Array.isArray(input) && !input.some((row) => object(row).id === id))
}
type Row = ReturnType<typeof records>[number]
type Prior = { phase?: string; original?: unknown; completed?: unknown }

function bound(
  row: Row | undefined,
  selected: ReturnType<typeof parse>,
  phase: unknown,
  id: string,
): asserts row is Row {
  check(
    row &&
      row.id === id &&
      row.phase === "reserved" &&
      row.receipt === undefined &&
      selected.version === 2 &&
      row.root === selected.root &&
      row.release === fingerprint(selected.source_sha256) &&
      phase === "closed",
    "Original reserved capture and exact current closed release required",
  )
}

function prepared(
  failed: z.infer<typeof failure> | undefined,
  original: Row,
  completed: Row,
  saved: Row[],
  diagnostics: unknown,
  audit?: Prior,
) {
  if (!failed) return
  check(
    isDeepStrictEqual(failed.completed, completed) &&
      failed.ledgerSHA === fingerprint({ turns: saved.map((row) => (row.id === original.id ? original : row)) }) &&
      failed.failuresSHA === fingerprint({ failures: diagnostics }) &&
      (!audit || isDeepStrictEqual(audit.original, failed.original)),
    "Exact original prepared extraction audit and unchanged ledger/failures required",
  )
}

function untouched(current: Row | undefined, original: Row, completed: Row, prior?: Prior) {
  check(
    isDeepStrictEqual(current, original) ||
      (prior &&
        ["prepared", "applied"].includes(String(prior.phase)) &&
        isDeepStrictEqual(prior.completed, completed) &&
        isDeepStrictEqual(current, completed)),
    "Original reservation is no longer an untouched pre-publication attempt",
  )
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
  const pending = storage.get<unknown>(`raya.secondBrain.captureExtractionFailure.${id}`)
  const failed = pending === undefined ? undefined : failure.parse(pending)
  const current = saved.find((row) => row.id === id)
  const original = audit ? records([audit.original])[0] : failed ? records([failed.original])[0] : current
  bound(original, selected, launch.phase, id)
  const completed = { ...original, phase: "skipped" as const }
  prepared(failed, original, completed, saved, diagnostics, audit)
  untouched(current, original, completed, audit ?? failed)
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
      isDeepStrictEqual(storage.get(`raya.secondBrain.captureExtractionFailure.${id}`), pending) &&
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
    ...(failed ? { extractionFailureSHA: fingerprint(failed) } : {}),
    closure,
    observation,
    qualification:
      "Abandon only a reserved attempt under the exact closed current owner; no saved facts or historical transport settlement authority",
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  }
}
