import path from "node:path"
import { readdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image, normalize } from "./control/identity"
import { resident } from "./control/catalog-capture"
import { descriptor, receipt } from "./managed/descriptor"
import { launch } from "./managed/restart"
import { fingerprint } from "./failed-repair"
import { finished } from "./failed-downstream"
import { journal } from "./journal"
import { parse as operation } from "./operation"
import { parse } from "./settings"

/** Published release metadata blocks quarantine even when it cannot settle a cold request. */
export async function unpublished(folder: string, request: string) {
  const names = await readdir(folder)
  check(names.length <= 8192, "Original Memory receipt namespace bound exceeded")
  for (const name of names.filter((name) => name.startsWith(request + "-") && name.endsWith(".json"))) {
    const file = await image(path.join(folder, name), 65536)
    check(
      object(document(file.raw, 65536).value).format !== "raya.memory.residency.release",
      "Published original residency proof must use original recovery instead of quarantine",
    )
  }
}

function binding(witness: ReturnType<typeof object>, entry: unknown, pending: unknown) {
  const saved = object(entry as Parameters<typeof object>[0])
  const setup = parse(saved.setup)
  const cfg = descriptor(saved.managed)
  const prior = object(saved.launch)
  const debt = journal(pending)
  const request = object(debt.request as Parameters<typeof object>[0])
  const original = receipt(prior.receipt)
  const closed = receipt(witness.closed)
  check(
    setup.version === 2 &&
      setup.protocol === "raya.memory.operation.v2" &&
      cfg.version === 2 &&
      resident(setup.source_sha256) &&
      path.basename(closed.path) === "managed-closed.json" &&
      (prior.phase === "closed"
        ? isDeepStrictEqual(original, closed)
        : prior.phase === "running" &&
          path.basename(original.path) === "managed-original.json" &&
          normalize(closed.path) === normalize(path.join(path.dirname(original.path), "managed-closed.json"))) &&
      debt.version === 2 &&
      debt.protocol === setup.protocol &&
      debt.root === setup.root &&
      request.op === "search" &&
      request.root === setup.root &&
      fingerprint(witness.debt) === fingerprint(debt) &&
      fingerprint(request.source_sha256) === fingerprint(setup.source_sha256) &&
      request.selected_release_sha256 === fingerprint(setup.source_sha256),
    "Only unchanged completed handoff debt with its original closed pair may be quarantined",
  )
  return { setup, cfg, closed, request, prior }
}

/** Exact completed search quarantine; no HTTP, replay, cleanup or settlement authority. */
export async function inspect(file: string, entry: unknown, pending: unknown) {
  await directory(path.dirname(file))
  const held = await image(file, 65536)
  const witness = object(document(held.raw, 65536).value)
  check(
    Object.keys(witness).sort().join() ===
      "closed,debt,entry_sha256,format,qualification,settlement_authority,terminal_file,version" &&
      witness.format === "raya.memory.completed-handoff.observation" &&
      witness.version === 1 &&
      witness.settlement_authority === false &&
      typeof witness.qualification === "string" &&
      witness.entry_sha256 === fingerprint(entry),
    "Exact completed handoff observation required",
  )
  const { setup, cfg, closed, request, prior } = binding(witness, entry, pending)
  await launch(cfg, setup, closed)
  const ended = await image(closed.path, 65536)
  check(
    ended.raw.length === closed.bytes && ended.digest === closed.sha256 && ended.tuple === closed.tuple,
    "Original closed pair changed during quarantine review",
  )
  const closure = object(document(ended.raw, 65536).value)
  const original = receipt(closure.original)
  check(
    prior.phase !== "running" || isDeepStrictEqual(original, receipt(prior.receipt)),
    "Deferred original running pair differs from its genuine closure",
  )
  const folder = path.dirname(original.path)
  check(
    normalize(cfg.namespaces.memory.root) === normalize(path.join(folder, "memory")) &&
      normalize(cfg.namespaces.retrieval.root) === normalize(path.join(folder, "retrieval")),
    "Original completed request namespaces must match the closed producer generation",
  )
  const selected = {
    request: String(request.id),
    epoch: String(request.owner_epoch),
    release: String(request.selected_release_sha256),
    digest: String(request.bodySHA),
    kind: "search" as const,
    protocol: "raya.memory.operation.v2" as const,
  }
  const ref = object(witness.terminal_file)
  const expected = path.join(
    cfg.namespaces.memory.root,
    "Requests",
    selected.epoch,
    selected.request + "-terminal.json",
  )
  check(
    Object.keys(ref).sort().join() === "bytes,path,sha256" &&
      typeof ref.path === "string" &&
      normalize(ref.path) === normalize(expected),
    "Exact original completed terminal location required",
  )
  await directory(path.dirname(expected))
  const terminal = await image(expected, 65536)
  check(terminal.raw.length === ref.bytes && terminal.digest === ref.sha256, "Original completed terminal changed")
  const value = object(operation(terminal.raw, selected, "terminal").operation)
  check(value.operation_outcome === "completed", "Only the exact completed search may enter handoff quarantine")
  await unpublished(path.dirname(expected), selected.request)
  const downstream = await finished(cfg, setup, value.downstream)
  return {
    setup,
    cfg,
    original,
    closed,
    selected,
    held,
    outcome: "completed" as const,
    downstream,
    terminal: { path: expected, bytes: terminal.raw.length, sha256: terminal.digest, tuple: terminal.tuple },
  }
}
