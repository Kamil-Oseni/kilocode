import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { image } from "./control/identity"
import { parseCatalog } from "./control/catalog"
import { receipt } from "./managed/descriptor"
import { fingerprint } from "./failed-repair"
import { records } from "./capture-intake"
import { parse } from "./settings"
import { document } from "./control/frames"

const setup = "raya.secondBrain.setup"
const catalog = "raya.secondBrain.control.catalog"
const ledger = "raya.secondBrain.personalCapture.turns"
const failures = "raya.secondBrain.personalCapture.failures"
const debt = "raya.secondBrain.control.uncertainty"
const source = "17c2f1e2d1e1d184cbf56c3434086a6d81f6d50b"
const digest = "630b85eb4533020a58c4ea45f669151a32d5cae8b57f9d85f493c731aade8dc4"
const schema = z
  .object({
    format: z.literal("raya.capture.catalog-refusal.review"),
    version: z.literal(1),
    capture: z.string().uuid(),
    package: z.unknown(),
    install: z.unknown(),
    binding: z.unknown(),
    observation: z.unknown(),
  })
  .strict()
type Storage = { get<T>(key: string): T | undefined }
const snapshot = z
  .object({
    [setup]: z.object({ setup: z.unknown(), credential: z.string(), managed: z.unknown() }).passthrough(),
    [catalog]: z.object({ root: z.string(), catalog: z.unknown() }).strict(),
    [ledger]: z.unknown(),
    [failures]: z.array(z.object({ id: z.string().uuid(), stage: z.string(), errors: z.array(z.string()) }).strict()),
    [debt]: z.unknown().optional(),
  })
  .passthrough()

function check(value: unknown, text: string): asserts value {
  if (!value) throw new Error(text)
}

async function read(input: unknown, limit = 1048576) {
  const ref = receipt(input)
  const held = await image(ref.path, limit)
  check(
    held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
    "Original capture refusal evidence changed",
  )
  return held
}

async function json(input: unknown) {
  const held = await read(input)
  document(held.raw, 1048576, 100000)
  return JSON.parse(held.raw.toString()) as unknown
}

async function installation(witness: z.infer<typeof schema>) {
  const archive = await read(witness.package, 200000000)
  check(archive.digest === digest && archive.raw.length === 191862000, "Source-qualified original package required")
  z.object({
    format: z.literal("raya.private.install.preservation"),
    source: z.literal(source),
    artifactSHA: z.literal(digest),
    savedStateUnchanged: z.literal(true),
    payloadsVerified: z.literal(299),
    runtimePinsVerified: z.literal(16),
  })
    .passthrough()
    .parse(await json(witness.install))
}

async function observation(witness: z.infer<typeof schema>) {
  const before = snapshot.parse(await json(witness.binding))
  const observed = z
    .object({
      source: z.literal(source),
      session: z.string(),
      replay: z.literal(false),
      ledger: z.unknown(),
      captureState: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .parse(await json(witness.observation))
  const saved = records(before[ledger])
  const original = saved.find((row) => row.id === witness.capture)
  check(
    original?.phase === "uncertain" && original.receipt === undefined,
    "Original uncertain capture without a receipt required",
  )
  const diagnostic = before[failures].find((row) => row.id === original.id)
  check(
    diagnostic?.stage === "authorization" && isDeepStrictEqual(diagnostic.errors, ["identity_mismatch"]),
    "Exact original pre-launch diagnostic required",
  )
  check(
    observed.session === original.sessionID &&
      isDeepStrictEqual(records(observed.ledger), saved) &&
      isDeepStrictEqual(observed.captureState?.[failures], before[failures]),
    "Original capture observation differs",
  )
  return { before, saved, original, diagnostic }
}

function binding(before: z.infer<typeof snapshot>, original: ReturnType<typeof records>[number], storage: Storage) {
  const prior = before[setup]
  const selected = parse(prior?.setup)
  const old = parseCatalog(before[catalog]?.catalog)
  check(
    selected.version === 2 &&
      old.version === 2 &&
      before[catalog].root === selected.root &&
      original.root === selected.root &&
      original.release === fingerprint(selected.source_sha256),
    "Original capture release binding differs",
  )
  const changed = Object.keys(selected.source_sha256)
    .filter((name) => old.source_sha256[name] !== selected.source_sha256[name])
    .sort()
  check(
    isDeepStrictEqual(changed, ["index.py", "server.py"]) &&
      Object.keys(old.source_sha256).length === 13 &&
      Object.keys(selected.source_sha256).length === 13,
    "Source-qualified catalog refusal before native launch required",
  )
  check(
    before[debt] === undefined && storage.get(debt) === undefined,
    "Original request debt cannot be reconciled as a catalog refusal",
  )
  const current = storage.get<{ setup: unknown; credential: string; managed: unknown }>(setup)
  const control = storage.get<{ root: string; catalog: unknown }>(catalog)
  check(
    current &&
      isDeepStrictEqual(current.setup, prior.setup) &&
      current.credential === prior.credential &&
      isDeepStrictEqual(current.managed, prior.managed) &&
      control?.root === original.root &&
      isDeepStrictEqual(parseCatalog(control.catalog).source_sha256, selected.source_sha256),
    "Current reviewed setup/control binding differs",
  )
}

/** One reviewed historical build only: its catalog check precedes Control.open. */
export async function review(input: unknown, storage: Storage) {
  const witness = schema.parse(input)
  await installation(witness)
  const { before, saved, original, diagnostic } = await observation(witness)
  binding(before, original, storage)
  const actual = records(storage.get(ledger))
  const completed = { ...original, phase: "skipped" as const }
  check(
    isDeepStrictEqual(storage.get(failures), before[failures]) &&
      (isDeepStrictEqual(actual, saved) ||
        isDeepStrictEqual(
          actual,
          saved.map((row) => (row.id === original.id ? completed : row)),
        )),
    "Original capture ledger or diagnostic changed",
  )
  return {
    format: "raya.capture.catalog-refusal.reconciliation" as const,
    version: 1 as const,
    original,
    completed,
    diagnostic,
    witness,
    ledgerSHA: fingerprint({ turns: saved }),
    qualification: "Source-qualified refusal before native launch; no historical transport settlement authority",
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  }
}
