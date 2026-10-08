import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { canonical, check, document, object, sha } from "./control/frames"
import { directory, image, normalize } from "./control/identity"
import { descriptor, receipt } from "./managed/descriptor"
import { launch } from "./managed/restart"
import { journal } from "./journal"
import { parse as operation } from "./operation"
import { parse } from "./settings"

export function fingerprint(value: unknown) {
  const parsed = document(Buffer.from(JSON.stringify(value)), 65536)
  return sha(canonical(parsed.tree, parsed.text, true).replace(/\u007f/g, "\\u007f"))
}

function observation(raw: Uint8Array, entry: unknown) {
  const witness = object(document(raw, 65536).value)
  check(
    Object.keys(witness).sort().join() ===
      [
        "format",
        "version",
        "observed",
        "entry_sha256",
        "debt",
        "original",
        "terminal",
        "terminal_file",
        "authenticated_original_http",
        "settlement_authority",
        "qualification",
      ]
        .sort()
        .join() &&
      witness.format === "raya.memory.failed-search.observation" &&
      witness.version === 1 &&
      witness.authenticated_original_http === true &&
      witness.settlement_authority === false &&
      typeof witness.observed === "number" &&
      Number.isFinite(witness.observed) &&
      witness.observed > 0 &&
      typeof witness.qualification === "string" &&
      witness.entry_sha256 === fingerprint(entry),
    "Explicit unchanged failed-search observation required",
  )
  return witness
}

/** Explicit operator review only. This observation never mints producer or native settlement authority. */
export async function review(file: string, entry: unknown, pending: unknown) {
  await directory(path.dirname(file))
  const held = await image(file, 65536)
  const witness = observation(held.raw, entry)
  const saved = object(entry as Parameters<typeof object>[0])
  const setup = parse(saved.setup)
  const cfg = descriptor(saved.managed)
  const prior = object(saved.launch)
  const debt = journal(pending)
  const request = object(debt.request as Parameters<typeof object>[0])
  check(
    setup.version === 2 &&
      setup.protocol === "raya.memory.operation.v2" &&
      cfg.version === 2 &&
      prior.phase === "running" &&
      debt.version === 2 &&
      debt.protocol === setup.protocol &&
      request.op === "search" &&
      request.root === setup.root &&
      fingerprint(witness.debt) === fingerprint(debt) &&
      fingerprint(request.source_sha256) === fingerprint(setup.source_sha256) &&
      request.selected_release_sha256 === fingerprint(setup.source_sha256) &&
      isDeepStrictEqual(receipt(witness.original), receipt(prior.receipt)),
    "Only the unchanged original v2 failed search may be reviewed",
  )
  const selected = {
    request: String(request.id),
    epoch: String(request.owner_epoch),
    release: String(request.selected_release_sha256),
    digest: String(request.bodySHA),
    kind: "search" as const,
    protocol: "raya.memory.operation.v2" as const,
    downstream: [],
  }
  const terminal = object(operation(Buffer.from(JSON.stringify(witness.terminal)), selected, "terminal").operation)
  check(terminal.operation_outcome === "failed", "Only a failed search with no downstream work may be repaired")
  const ref = object(witness.terminal_file)
  const expected = path.join(
    cfg.namespaces.memory.root,
    "Requests",
    selected.epoch,
    `${selected.request}-terminal.json`,
  )
  check(
    Object.keys(ref).sort().join() === "bytes,path,sha256" &&
      typeof ref.path === "string" &&
      normalize(ref.path) === normalize(expected),
    "Original failed terminal location differs",
  )
  await directory(path.dirname(expected))
  const current = await image(expected, 65536)
  check(
    current.raw.length === ref.bytes &&
      current.digest === ref.sha256 &&
      isDeepStrictEqual(document(current.raw, 65536).value, witness.terminal),
    "Original failed terminal changed",
  )
  const original = receipt(prior.receipt)
  const location = path.join(path.dirname(original.path), "managed-closed.json")
  await directory(path.dirname(location))
  const ended = await image(location, 65536)
  const closed = receipt({ path: location, bytes: ended.raw.length, sha256: ended.digest, tuple: ended.tuple })
  const closure = object(document(ended.raw, 65536).value)
  check(isDeepStrictEqual(receipt(closure.original), original), "Closed pair belongs to a different original launch")
  await launch(cfg, setup, closed)
  return Object.freeze({
    request: selected.request,
    root: setup.root,
    outcome: "failed" as const,
    closed,
    observation: Object.freeze({ path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }),
    qualification: "Explicit metadata repair; original clean producer pair only, no model or native family acceptance",
  })
}
