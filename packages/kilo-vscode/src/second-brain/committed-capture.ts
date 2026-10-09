import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { parse } from "./settings"
import { journal } from "./journal"
import { descriptor, receipt } from "./managed/descriptor"
import { parse as plan } from "./managed/value"
import { review as closed } from "./closed-recovery"
import { fingerprint } from "./failed-repair"
import { parse as operation } from "./operation"
import { check, document, object } from "./control/frames"
import { directory, image, normalize, environment } from "./control/identity"
import { command } from "./control/command"

const helper = "7f41ea4776d51da5c6f294fa0ddcfb78136d9a775462ec5fdb6bdc7f85c43a91"
const qualified = new WeakSet<object>()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const turn = z
  .object({
    id: z.string().uuid(),
    project: z.string().min(1).max(4096),
    sessionID: z.string().min(1).max(256),
    messageID: z.string().min(1).max(256),
    source_sha256: hash,
    root: z.string().min(1).max(4096),
    release: hash,
    phase: z.enum(["saving", "uncertain"]),
    receipt: hash.optional(),
  })
  .strict()
const effect = z
  .object({
    format: z.literal("raya.memory.committed-capture.review"),
    version: z.literal(1),
    capture: z.string().uuid(),
    inputSHA: hash,
    journalSHA: hash,
    policySHA: hash,
    previousPolicySHA: hash,
    result: z
      .object({
        id: z.string().uuid(),
        status: z.literal("committed"),
        duplicate: z.literal(false),
        note_sha256: z.record(z.string(), hash),
        input_sha256: hash,
      })
      .strict(),
    requestSettlement: z.literal(false),
    replay: z.literal(false),
    indexConfirmed: z.literal(false),
  })
  .strict()

async function retained(input: unknown, limit = 65536) {
  const ref = receipt(input)
  await directory(path.dirname(ref.path))
  const held = await image(ref.path, limit)
  check(
    held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
    "Original capture recovery image changed",
  )
  return held
}

async function retrieval(cfg: ReturnType<typeof descriptor>) {
  check(cfg.retrieval !== undefined, "Original capture Retrieval plan required")
  const held = await image(cfg.retrieval.path, 16777216)
  check(
    held.raw.length === cfg.retrieval.bytes && held.digest === cfg.retrieval.sha256,
    "Original capture Retrieval plan differs",
  )
  const value = object(plan(held.raw))
  check(
    Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535,
    "Original capture Retrieval port differs",
  )
  return { port: Number(value.port), ref: { ...cfg.retrieval, tuple: held.tuple } }
}

function selection(entry: Parameters<typeof closed>[0], pending: unknown, input: unknown) {
  const setup = parse(entry.setup)
  const cfg = descriptor(entry.managed)
  const debt = journal(pending)
  const request = object(debt.request as Parameters<typeof object>[0])
  const selected = turn.parse(input)
  check(
    setup.version === 2 &&
      setup.protocol === "raya.memory.operation.v2" &&
      cfg.version === 2 &&
      debt.version === 2 &&
      debt.protocol === setup.protocol &&
      request.op === "capture" &&
      debt.root === setup.root &&
      selected.root === setup.root &&
      selected.release === fingerprint(setup.source_sha256) &&
      request.selected_release_sha256 === selected.release &&
      isDeepStrictEqual(request.source_sha256, setup.source_sha256),
    "Original interrupted capture selection required",
  )
  return { setup, cfg, debt, request, selected }
}

/** Correlate committed effects only. This review never settles, replays or indexes a request. */
export async function review(extension: string, entry: Parameters<typeof closed>[0], pending: unknown, input: unknown) {
  const choice = selection(entry, pending, input)
  const setup = choice.setup
  const cfg = choice.cfg
  const debt = choice.debt
  const request = choice.request
  const selected = choice.selected
  const prior = object(entry.launch as Parameters<typeof object>[0])
  check(prior.phase === "running" || prior.phase === "closed", "Original capture pair phase required")
  const ended = prior.phase === "closed" ? object(document((await retained(prior.receipt)).raw).value) : undefined
  const running = ended ? { ...entry, launch: { phase: "running", receipt: receipt(ended.original) } } : entry
  const closure = await closed(running)
  const paired = await retrieval(cfg)
  if (ended) check(isDeepStrictEqual(receipt(prior.receipt), closure.closed), "Saved capture closure differs")
  const held = await image(cfg.plan.path, 16777216)
  check(held.raw.length === cfg.plan.bytes && held.digest === cfg.plan.sha256, "Original capture plan differs")
  const source = object(plan(held.raw))
  check(
    typeof source.source === "string" &&
      normalize(source.source) === normalize(path.join(cfg.root, "source", "memory")) &&
      fingerprint(source.source_sha256) === fingerprint(setup.source_sha256),
    "Original capture source plan differs",
  )
  await directory(source.source)
  const pins = await Promise.all(
    Object.entries(setup.source_sha256).map(async ([name, digest]) => {
      const file = path.join(String(source.source), name)
      const held = await image(file)
      check(held.digest === digest, "Original capture source image differs")
      return { path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }
    }),
  )
  const identity = {
    kind: "capture" as const,
    protocol: "raya.memory.operation.v2" as const,
    request: String(request.id),
    epoch: String(request.owner_epoch),
    release: String(request.selected_release_sha256),
    digest: String(request.bodySHA),
  }
  const folder = path.join(cfg.namespaces.memory.root, "Requests", identity.epoch)
  await directory(folder)
  const records = await Promise.all(
    ["pending", "terminal"].map(async (mode) => {
      const file = path.join(folder, `${identity.request}-${mode}.json`)
      const held = await image(file, 65536)
      operation(held.raw, identity, mode as "pending" | "terminal")
      return { ref: { path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }, raw: held.raw }
    }),
  )
  const terminal = object(document(records[1].raw).value)
  check(
    terminal.operation_outcome === "completed" &&
      Array.isArray(terminal.downstream) &&
      terminal.downstream.length === 0,
    "Committed capture requires its completed original terminal without downstream work",
  )
  const script = path.join(extension, "script", "memory", "capture_recovery.py")
  await directory(path.dirname(script))
  const code = await image(script)
  check(code.digest === helper, "Committed capture review helper differs")
  const python = await image(cfg.python.path, 16777216)
  check(
    python.raw.length === cfg.python.bytes && python.digest === cfg.python.sha256,
    "Original capture interpreter differs",
  )
  const body = JSON.stringify({
    source: source.source,
    root: setup.root,
    pins: setup.source_sha256,
    turn: selected,
    bodySHA: identity.digest,
    resultSHA: terminal.result_sha256,
  })
  check(Buffer.byteLength(body) <= 8192, "Committed capture review metadata exceeds its bound")
  const result = await command(cfg.python.path, ["-I", "-S", "-B", script, body], {
    cwd: cfg.root,
    env: environment(),
  })
  check(result.stderr === "", "Committed capture review emitted diagnostics")
  const value = effect.parse(JSON.parse(result.stdout))
  check(
    value.capture === selected.id && value.result.id === selected.id && value.inputSHA === value.result.input_sha256,
    "Committed capture review identity differs",
  )
  operation(Buffer.from(JSON.stringify({ ...value.result, operation: terminal })), identity, "response")
  await Promise.all([...pins, paired.ref, ...records.map((item) => item.ref)].map((ref) => retained(ref, 16777216)))
  check(isDeepStrictEqual(await closed(running), closure), "Original capture closure changed during review")
  check(
    isDeepStrictEqual(await image(script), code) &&
      isDeepStrictEqual(await image(cfg.python.path, 16777216), python) &&
      isDeepStrictEqual(await image(cfg.plan.path, 16777216), held),
    "Original capture review execution selection changed",
  )
  const reviewed = Object.freeze({
    ...value,
    root: setup.root,
    request: identity.request,
    entrySHA: fingerprint(entry),
    debtSHA: fingerprint(debt),
    evidence: {
      plan: { ...cfg.plan, tuple: held.tuple },
      retrieval: paired.ref,
      source: pins,
      operations: records.map((item) => item.ref),
      helper: { path: script, bytes: code.raw.length, sha256: code.digest, tuple: code.tuple },
      python: { ...cfg.python, tuple: python.tuple },
    },
    closure: { ...closure, ports: [...new Set([...closure.ports, paired.port])].sort((a, b) => a - b) },
    producer: result.receipt,
    qualification:
      "Read-only committed-effect correlation; administrative review required, no original settlement authority",
  })
  qualified.add(reviewed)
  return reviewed
}

/** Retain the historical helper reference only after a fresh pinned helper reproduces every original effect field. */
export function rebind(value: Awaited<ReturnType<typeof review>>, audit: unknown) {
  if (audit === undefined) return value
  check(qualified.has(value), "Fresh native capture review required")
  const retained = audit as { reviewSHA?: unknown; review?: unknown }
  check(retained.reviewSHA === fingerprint(retained.review), "Original capture review digest differs")
  const prior = retained.review as Omit<typeof value, "producer">
  check(prior?.evidence?.helper, "Original capture helper reference required")
  const ref = receipt(prior.evidence.helper)
  check(
    ref.sha256 === helper && ref.sha256 === value.evidence.helper.sha256 && ref.bytes === value.evidence.helper.bytes,
    "Original capture helper release differs",
  )
  const canonical = Object.freeze({ ...value, evidence: { ...value.evidence, helper: ref } })
  const { producer, ...evidence } = canonical
  check(
    producer.code === 0 && producer.originalJoined && producer.readersJoined && isDeepStrictEqual(prior, evidence),
    "Original capture effect changed across helper installation",
  )
  qualified.add(canonical)
  return canonical
}
