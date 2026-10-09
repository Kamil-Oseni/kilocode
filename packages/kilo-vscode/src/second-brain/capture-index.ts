import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image, normalize } from "./control/identity"
import { descriptor, receipt, selection } from "./managed/descriptor"
import { parse } from "./settings"
import { journal } from "./journal"
import { fingerprint } from "./failed-repair"
import { retained } from "./failed-downstream"
import { records } from "./capture-intake"
import { parse as operation } from "./operation"
import { review as capture, rebind } from "./committed-capture"
import { review as closed } from "./closed-recovery"

type Entry = { setup: unknown; managed?: unknown; launch?: unknown; credential?: unknown }

async function namespace(folder: string, epoch: unknown) {
  await directory(folder)
  const before = await lstat(folder, { bigint: true })
  const owners = await readdir(folder)
  check(
    owners.length === 1 && owners[0] === epoch && /^[a-f0-9]{32}$/.test(owners[0]),
    "One exact current pair index owner required",
  )
  const after = await lstat(folder, { bigint: true })
  const tuple = (value: typeof before) => [value.dev, value.ino, value.mtimeNs, value.ctimeNs].join(":")
  check(tuple(before) === tuple(after), "Current pair index namespace changed")
  return { path: folder, owner: epoch, tuple: tuple(before) }
}

async function ending(entry: Entry) {
  const prior = object(entry.launch as Parameters<typeof object>[0])
  check(prior.phase === "running" || prior.phase === "closed", "Failed index original pair required")
  if (prior.phase === "running") return closed(entry)
  const ref = receipt(prior.receipt)
  const file = await image(ref.path, 65536)
  check(
    file.raw.length === ref.bytes && file.digest === ref.sha256 && file.tuple === ref.tuple,
    "Failed index saved closure changed",
  )
  const value = object(document(file.raw).value)
  const result = await closed({ ...entry, launch: { phase: "running", receipt: receipt(value.original) } })
  check(isDeepStrictEqual(ref, result.closed), "Failed index closure differs from original pair")
  return result
}

function applied(original: unknown, input: unknown) {
  const audit = original as {
    format?: unknown
    version?: unknown
    phase?: unknown
    requestSettlement?: unknown
    indexConfirmed?: unknown
    replay?: unknown
    previous?: Entry
    debt?: unknown
    turn?: unknown
    reviewSHA?: unknown
    review?: unknown
  }
  check(
    audit?.format === "raya.memory.committed-capture.recovery" &&
      audit.version === 1 &&
      audit.phase === "applied" &&
      audit.requestSettlement === false &&
      audit.indexConfirmed === false &&
      audit.replay === false &&
      audit.previous &&
      audit.reviewSHA === fingerprint(audit.review),
    "Applied original committed save audit required",
  )
  const previous = audit.previous!
  const turn = records([audit.turn])[0]
  const requested = records([input])[0]
  check(turn && requested && isDeepStrictEqual(turn, requested), "Exact recovered original save required")
  return { audit, previous, turn }
}

function binding(entry: Entry, pending: unknown, previous: Entry) {
  const setup = parse(entry.setup)
  const cfg = descriptor(entry.managed)
  const before = parse(previous.setup)
  check(
    typeof entry.credential === "string" &&
      /^raya\.secondBrain\.key\.[a-f0-9-]{36}$/.test(entry.credential) &&
      entry.credential === previous.credential &&
      cfg.root === descriptor(previous.managed).root &&
      setup.root === before.root &&
      setup.version === 2 &&
      cfg.version === 2,
    "Failed index belongs to a different recovered Memory setup",
  )
  const debt = journal(pending)
  const request = object(debt.request as Parameters<typeof object>[0])
  check(
    debt.version === 2 &&
      debt.protocol === setup.protocol &&
      debt.root === setup.root &&
      request.op === "sync" &&
      request.root === setup.root &&
      request.selected_release_sha256 === fingerprint(setup.source_sha256) &&
      isDeepStrictEqual(request.source_sha256, setup.source_sha256) &&
      request.bodySHA === fingerprint({ force_rebuild: false, expected_policy_sha256: request.expected }),
    "Exact later refused index selection required",
  )
  return { setup, cfg, debt, request }
}

/** Review a later failed index independently of the already recovered original save. Never replay or settle either. */
export async function review(extension: string, entry: Entry, pending: unknown, input: unknown, original: unknown) {
  const auditSHA = fingerprint(original)
  const entrySHA = fingerprint(entry)
  const debtSHA = fingerprint(pending)
  const { audit, previous, turn } = applied(original, input)
  const { setup, cfg, debt, request } = binding(entry, pending, previous)
  await selection(cfg, setup)
  const saved = rebind(await capture(extension, previous, audit.debt, turn), audit)
  check(
    saved.policySHA === request.expected && saved.request !== request.id,
    "Failed index policy differs from the recovered original save",
  )
  const closure = await ending(entry)
  check(
    normalize(cfg.namespaces.memory.root) === normalize(path.join(path.dirname(closure.original.path), "memory")),
    "Failed index namespace differs from its genuine closed pair",
  )
  const owner = await namespace(path.join(cfg.namespaces.memory.root, "Requests"), request.owner_epoch)
  const folder = path.join(owner.path, String(request.owner_epoch))
  await directory(folder)
  const chosen = {
    request: String(request.id),
    epoch: String(request.owner_epoch),
    release: String(request.selected_release_sha256),
    digest: String(request.bodySHA),
    kind: "sync" as const,
    protocol: "raya.memory.operation.v2" as const,
  }
  const files = await Promise.all(
    ["pending", "terminal"].map(async (mode) => {
      const target = path.join(folder, `${chosen.request}-${mode}.json`)
      const file = await image(target, 65536)
      operation(file.raw, chosen, mode as "pending" | "terminal")
      return { path: target, bytes: file.raw.length, sha256: file.digest, tuple: file.tuple, raw: file.raw }
    }),
  )
  const terminal = object(document(files[1].raw).value)
  check(
    ["failed", "cancelled"].includes(String(terminal.operation_outcome)) &&
      Array.isArray(terminal.downstream) &&
      terminal.downstream.length > 0,
    "Later index must retain its failed preworker terminal",
  )
  const downstream = await retained(cfg, setup, terminal.downstream)
  const operations = files.map(({ raw, ...ref }) => ref)
  await Promise.all(
    [...operations, ...downstream.flatMap((item) => item.files)].map(async (ref) => {
      const file = await image(ref.path, 65536)
      check(
        file.raw.length === ref.bytes && file.digest === ref.sha256 && file.tuple === ref.tuple,
        "Later failed index evidence changed",
      )
    }),
  )
  check(isDeepStrictEqual(await ending(entry), closure), "Later failed index closure changed")
  check(isDeepStrictEqual(await namespace(owner.path, request.owner_epoch), owner), "Later index owner changed")
  check(
    fingerprint(original) === auditSHA && fingerprint(entry) === entrySHA && fingerprint(pending) === debtSHA,
    "Original audit or failed index selection changed during review",
  )
  return Object.freeze({
    capture: saved,
    closure,
    request: chosen.request,
    debtSHA: fingerprint(debt),
    entrySHA,
    auditSHA,
    expected: request.expected,
    outcome: terminal.operation_outcome,
    operations,
    downstream,
    namespace: owner,
    requestSettlement: false,
    indexConfirmed: false,
    replay: false,
    qualification: "Exact failed index within the genuine closed pair protected namespace; no kernel-to-epoch claim",
  })
}
