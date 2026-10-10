import path from "node:path"
import { z } from "zod"
import { records } from "./capture-intake"
import { fingerprint } from "./failed-repair"
import { directory, environment, image } from "./control/identity"
import { check } from "./control/frames"
import { command } from "./control/command"
import { acceptance } from "./control/acceptance"

const pin = "8ee7bc82dc5e1e2b15bbf51a48e678833fc6d3a8ea4116521dc89e36fc3e5259"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z
  .object({
    format: z.literal("raya.memory.capture-revisions.v1"),
    effect: z.record(z.string(), z.unknown()),
    policySHA: hash,
    chain: z.array(z.string().uuid()).max(64),
    membership: z.array(z.string().min(1).max(256)).max(10000),
    ignore_present: z.boolean(),
    witnesses: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            bytes: z.number().int().min(0).max(16777216),
            sha256: hash,
            tuple: z
              .string()
              .regex(/^\d{1,20}(?::\d{1,20}){5}$/)
              .refine((value) => value.split(":").every((item) => BigInt(item) <= 18446744073709551615n)),
          })
          .strict(),
      )
      .max(1024),
    requestSettlement: z.literal(false),
    replay: z.literal(false),
    indexConfirmed: z.literal(false),
  })
  .strict()
type Ref = { path: string; bytes: number; sha256: string }
type Scope = {
  audit: unknown
  ledger: unknown
  guard: () => void
  operations?: readonly {
    capture: string
    inputSHA: string
    bodySHA: string
    resultSHA: string
    pendingRef: Ref
    terminalRef: Ref
    epoch: string
    release: string
    source_sha256: Record<string, string>
  }[]
  dispose?: () => void
  refresh?: () => Promise<void>
  projection?: () => object
}
type Config = { root: string; python: Ref; plan: Ref; retrieval?: Ref }
const proofs = new WeakMap<
  object,
  {
    policy: string
    refresh: () => Promise<void>
    guard: () => void
    digest: string
    dispose?: () => void
    projection?: () => object
  }
>()
const required = new Set<string>()
const eligible = new WeakMap<object, ReadonlyMap<string, string>>()

export async function review(extension: string, runtime: Config, input: string, opts?: Scope) {
  if (!opts) return undefined
  const cfg = structuredClone(runtime)
  const scope = Object.freeze({
    audit: structuredClone(opts.audit),
    ledger: structuredClone(opts.ledger),
    operations: structuredClone(opts.operations ?? []),
    guard: opts.guard,
    refresh: opts.refresh,
    dispose: opts.dispose,
    projection: opts.projection,
  })
  scope.guard()
  const body = JSON.parse(input) as { root: string; turn: { id: string } }
  const audit = scope.audit as {
    reviewSHA?: unknown
    phase?: unknown
    turn?: { id?: unknown }
    review?: { policySHA?: unknown; previousPolicySHA?: unknown; journalSHA?: unknown }
  }
  check(
    audit.phase === "applied" && audit.turn?.id === body.turn.id && audit.reviewSHA === fingerprint(audit.review),
    "Exact applied original revision anchor required",
  )
  const current = await image(path.join(body.root, "System", "general-admission.json"))
  scope.guard()
  const ledger = records(scope.ledger)
  check(new Set(ledger.map((row) => row.id)).size === ledger.length, "Unique authoritative capture ledger required")
  const rows = ledger.filter((row) => row.root === body.root && row.id !== body.turn.id && row.phase === "published")
  check(rows.length <= 64, "Historical capture review exceeds its 64-row capacity")
  const roots = [...new Set((scope.operations ?? []).map((row) => path.dirname(path.dirname(row.pendingRef.path))))]
  const metadata = JSON.stringify({
    ...JSON.parse(input),
    history: {
      policySHA: audit.review?.policySHA,
      previousPolicySHA: audit.review?.previousPolicySHA,
      journalSHA: audit.review?.journalSHA,
      compact: true,
      roots,
      rows: rows.map((row) => [
        row.id,
        row.project,
        row.sessionID,
        row.messageID,
        row.source_sha256,
        row.receipt,
        row.release,
      ]),
      operations: (scope.operations ?? []).map((row) => [
        row.capture,
        row.bodySHA,
        roots.indexOf(path.dirname(path.dirname(row.pendingRef.path))),
        row.epoch,
        path.basename(row.pendingRef.path).slice(0, 32),
        row.pendingRef.sha256,
        row.terminalRef.sha256,
      ]),
    },
  })
  check(Buffer.byteLength(metadata) <= 8192, "Historical capture metadata exceeds its 8192-byte capacity")
  const script = path.join(extension, "script", "memory", "capture_revision.py")
  const args = ["-I", "-S", "-B", script, metadata]
  check(
    [cfg.python.path, ...args].reduce((size, arg) => size + arg.length * 2 + 3, 0) < 32767,
    "Historical capture quoted Windows invocation exceeds its capacity",
  )
  await directory(path.dirname(script))
  scope.guard()
  const helper = await image(script)
  check(helper.digest === pin, "Historical capture helper differs")
  const bindings: (Ref & { tuple: string })[] = []
  for (const ref of [
    cfg.python,
    cfg.plan,
    ...(cfg.retrieval ? [cfg.retrieval] : []),
    ...(scope.operations ?? []).flatMap((row) => [row.pendingRef, row.terminalRef]),
  ]) {
    const held = await image(ref.path, Math.max(1, ref.bytes))
    scope.guard()
    check(held.raw.length === ref.bytes && held.digest === ref.sha256, "Historical capture execution reference differs")
    bindings.push({ ...ref, tuple: held.tuple })
  }
  const selected = JSON.parse(input) as { source: string; pins: Record<string, string> }
  for (const [name, sha256] of Object.entries(selected.pins)) {
    const file = path.join(selected.source, name)
    const held = await image(file)
    scope.guard()
    check(held.digest === sha256, "Historical capture source reference differs")
    bindings.push({ path: file, bytes: held.raw.length, sha256, tuple: held.tuple })
  }
  const bound = async () => {
    scope.guard()
    for (const ref of bindings) {
      const held = await image(ref.path, Math.max(1, ref.bytes))
      scope.guard()
      check(
        held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
        "Historical capture execution reference changed",
      )
    }
  }
  const execute = async () => {
    await scope.refresh?.()
    scope.guard()
    await bound()
    const selected = await image(script)
    check(selected.digest === helper.digest && selected.tuple === helper.tuple, "Historical capture helper changed")
    scope.guard()
    const output = await command(cfg.python.path, args, {
      cwd: cfg.root,
      env: environment(),
    })
    await bound()
    await scope.refresh?.()
    scope.guard()
    check(output.stderr === "", "Historical capture review emitted diagnostics")
    const value = schema.parse(JSON.parse(output.stdout))
    check(
      new Set(value.witnesses.map((ref) => ref.path)).size === value.witnesses.length &&
        new Set(value.chain).size === value.chain.length,
      "Unique historical revision witnesses required",
    )
    const refs = []
    for (const ref of value.witnesses) {
      await directory(path.dirname(ref.path))
      scope.guard()
      const held = await image(ref.path, Math.max(1, ref.bytes))
      scope.guard()
      check(
        held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
        "Historical capture witness changed",
      )
      refs.push({ ...ref, tuple: held.tuple })
    }
    check((await image(script)).tuple === helper.tuple, "Historical capture helper changed after review")
    scope.guard()
    return { value, refs, producer: output.receipt }
  }
  const observed = await execute()
  check(
    observed.refs.some(
      (ref) =>
        path.resolve(ref.path) === path.resolve(path.join(body.root, "System", "general-admission.json")) &&
        ref.tuple === current.tuple &&
        ref.sha256 === current.digest &&
        ref.bytes === current.raw.length,
    ),
    "Current policy identity changed during historical review",
  )
  const baseline = fingerprint({
    value: fingerprint(observed.value),
    refs: observed.refs.map((ref) => fingerprint(ref)),
  })
  check(observed.value.policySHA === current.digest, "Current policy changed during historical review")
  scope.guard()
  const proof = Object.freeze({
    policy: observed.value.policySHA,
    dispose: scope.dispose,
    projection: scope.projection,
    guard: scope.guard,
    refresh: async () => {
      scope.guard()
      const fresh = await execute()
      check(
        fingerprint({ value: fingerprint(fresh.value), refs: fresh.refs.map((ref) => fingerprint(ref)) }) === baseline,
        "Historical capture revision evidence changed",
      )
      scope.guard()
    },
  })
  eligible.set(
    proof,
    new Map(Object.entries(observed.value.effect).map(([field, value]) => [field, fingerprint({ value })])),
  )
  return {
    effect: observed.value.effect,
    producer: observed.producer,
    proof,
    bytes: Buffer.byteLength(metadata),
  }
}

export function attach(value: object, proof: NonNullable<Awaited<ReturnType<typeof review>>>["proof"]) {
  check(eligible.has(proof), "Original native historical qualification required")
  for (const [field, expected] of eligible.get(proof)!)
    check(
      fingerprint({ value: (value as Record<string, unknown>)[field] ?? null }) === expected,
      "Historical qualification differs from its original effect",
    )
  proof.guard()
  const capture = (value as { capture?: unknown }).capture
  check(typeof capture === "string", "Original historical capture identity required")
  required.add(capture)
  proofs.set(value, { ...proof, digest: fingerprint(value) })
}

export function transfer(from: object, to: object) {
  const proof = proofs.get(from)
  if (!proof) return
  check(fingerprint(from) === proof.digest, "Historical review object changed")
  for (const field of [
    "capture",
    "inputSHA",
    "journalSHA",
    "policySHA",
    "previousPolicySHA",
    "result",
    "root",
    "entrySHA",
  ]) {
    check(
      fingerprint({ value: (from as Record<string, unknown>)[field] ?? null }) ===
        fingerprint({ value: (to as Record<string, unknown>)[field] ?? null }),
      "Historical review transfer differs",
    )
  }
  proof.guard()
  proofs.set(to, { ...proof, digest: fingerprint(to) })
}

function selected(value: object) {
  const proof = proofs.get(value)
  check(
    proof || !required.has(String((value as { capture?: unknown }).capture)),
    "Historical capture qualification was not retained",
  )
  proof?.guard()
  if (proof) check(fingerprint(value) === proof.digest, "Historical review object changed")
  return proof
}

export function currentPolicy(value: object) {
  return selected(value)?.policy ?? hash.parse((value as { policySHA?: unknown }).policySHA)
}

/** Reuse only private deterministic projection bytes; native evidence remains freshly reviewed. */
export function projection(value: object) {
  return selected(value)?.projection?.()
}

export async function freshHistory(value: object, caller: () => void = () => {}) {
  caller()
  const proof = selected(value)
  await acceptance(
    () => {
      caller()
      proof?.guard()
    },
    async () => {
      await proof?.refresh()
    },
  )
  caller()
  selected(value)
}

/** Retire pure projection buffers; full freshness remains available uncached. */
export function disposeHistory(value: object) {
  proofs.get(value)?.dispose?.()
}
