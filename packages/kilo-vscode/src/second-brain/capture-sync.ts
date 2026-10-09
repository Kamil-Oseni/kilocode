import path from "node:path"
import { readdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image } from "./control/identity"
import { descriptor } from "./managed/descriptor"
import { parse } from "./settings"
import { journal } from "./journal"
import { fingerprint } from "./failed-repair"
import { retained } from "./failed-downstream"
import { records } from "./capture-intake"
import { parse as operation } from "./operation"

type Entry = { setup: unknown; managed?: unknown; launch?: unknown }
type Capture = { policySHA: string; request: string; debtSHA: string }

function binding(entry: Entry, pending: unknown, input: unknown) {
  const setup = parse(entry.setup)
  const cfg = descriptor(entry.managed)
  const debt = journal(pending)
  const request = object(debt.request as Parameters<typeof object>[0])
  const turn = records([input])[0]
  check(
    setup.version === 2 &&
      cfg.version === 2 &&
      debt.version === 2 &&
      debt.protocol === setup.protocol &&
      request.op === "sync" &&
      request.root === setup.root &&
      debt.root === setup.root &&
      turn &&
      ["saving", "uncertain"].includes(turn.phase) &&
      turn.root === setup.root &&
      turn.release === fingerprint(setup.source_sha256) &&
      request.selected_release_sha256 === turn.release &&
      isDeepStrictEqual(request.source_sha256, setup.source_sha256),
    "Exact original committed save and refused index selection required",
  )
  return { setup, cfg, debt, request, turn }
}

async function residency(
  folder: string,
  original: ReturnType<typeof object>,
  downstream: Awaited<ReturnType<typeof retained>>,
) {
  const names = await readdir(folder)
  check(
    names.length <= 8192 && downstream.length === 1,
    "Bounded original residency and refused downstream proof required",
  )
  const matches = []
  for (const name of names.filter(
    (name) => name.startsWith(String(original.request) + "-") && /^[a-f0-9]{32}-[a-f0-9]{32}\.json$/.test(name),
  )) {
    const file = await image(path.join(folder, name), 65536)
    const value = object(document(file.raw).value)
    if (value.format !== "raya.memory.residency.release") continue
    const released = object(value.downstream)
    check(
      value.version === 2 &&
        value.request === original.request &&
        value.owner_epoch === original.owner_epoch &&
        value.selected_release_sha256 === original.selected_release_sha256 &&
        value.operation_receipt_sha256 === original.receipt_sha256 &&
        released.format === "raya.retrieval.idle.release" &&
        released.version === 2 &&
        released.owner_epoch === downstream[0].receipt.owner_epoch &&
        released.selected_release_sha256 === downstream[0].receipt.selected_release_sha256 &&
        [
          "original_worker_retired",
          "request_publications_confirmed",
          "request_admissions_joined",
          "coordinator_retained",
        ].every((name) => released[name] === true) &&
        released.queued_requests_cancelled === false &&
        released.draining === false,
      "Genuine original capture residency release required",
    )
    matches.push({ path: path.join(folder, name), bytes: file.raw.length, sha256: file.digest, tuple: file.tuple })
  }
  check(matches.length === 1, "One exact original capture residency release required")
  return matches[0]
}

/** A failed reindex is separate from its committed save; correlate both, never replay either. */
export async function review<A extends Capture>(
  extension: string,
  entry: Entry,
  pending: unknown,
  input: unknown,
  correlate: (extension: string, entry: Entry, pending: unknown, input: unknown) => Promise<A>,
) {
  const { setup, cfg, debt, request, turn } = binding(entry, pending, input)
  check(
    request.bodySHA === fingerprint({ force_rebuild: false, expected_policy_sha256: request.expected }),
    "Original index request body differs",
  )
  const folder = path.join(cfg.namespaces.memory.root, "Requests", String(request.owner_epoch))
  await directory(folder)
  const selected = {
    request: String(request.id),
    epoch: String(request.owner_epoch),
    release: String(request.selected_release_sha256),
    digest: String(request.bodySHA),
    kind: "sync" as const,
    protocol: "raya.memory.operation.v2" as const,
  }
  const files = await Promise.all(
    ["pending", "terminal"].map(async (mode) => {
      const file = await image(path.join(folder, `${selected.request}-${mode}.json`), 65536)
      operation(file.raw, selected, mode as "pending" | "terminal")
      return file
    }),
  )
  const terminal = object(document(files[1].raw).value)
  check(
    ["failed", "cancelled"].includes(String(terminal.operation_outcome)) &&
      Array.isArray(terminal.downstream) &&
      terminal.downstream.length > 0,
    "Original index must retain its failed preworker terminal",
  )
  const downstream = await retained(cfg, setup, terminal.downstream)
  const notes = path.join(setup.root, "System", "Changes", turn.id, "manifest.json")
  const publication = path.join(setup.root, "System", "Capture", turn.id, "input.json")
  const manifest = object(document((await image(notes, 65536)).raw).value)
  const body = document((await image(publication, 65536)).raw).value
  check(
    manifest.id === turn.id &&
      manifest.status === "committed" &&
      Array.isArray(manifest.changes) &&
      manifest.changes.length <= 128,
    "Original committed change manifest required",
  )
  const result = fingerprint({
    id: turn.id,
    status: "committed",
    duplicate: false,
    note_sha256: Object.fromEntries(
      manifest.changes.map((item) => {
        const row = object(item)
        return [row.path, row.new_sha256]
      }),
    ),
    input_sha256: fingerprint(body),
  })
  const names = await readdir(folder)
  check(names.length <= 8192, "Original operation namespace exceeds its bound")
  const matches = []
  for (const name of names.filter((name) => /^[a-f0-9]{32}-terminal\.json$/.test(name))) {
    const file = await image(path.join(folder, name), 65536)
    const value = object(document(file.raw).value)
    if (value.kind !== "capture" || value.operation_outcome !== "completed" || value.result_sha256 !== result) continue
    check(
      value.owner_epoch === selected.epoch &&
        value.selected_release_sha256 === selected.release &&
        value.request === name.slice(0, 32) &&
        value.request !== selected.request,
      "Original capture and index owners or filenames differ",
    )
    matches.push({ value, file })
  }
  check(matches.length === 1, "One exact completed original capture must precede the refused index")
  const original = matches[0].value
  const correlation = {
    format: "raya.memory.control.uncertainty",
    version: 2,
    protocol: setup.protocol,
    root: setup.root,
    request: {
      op: "capture",
      id: original.request,
      root: setup.root,
      owner_epoch: original.owner_epoch,
      selected_release_sha256: original.selected_release_sha256,
      bodySHA: original.request_sha256,
      source_sha256: setup.source_sha256,
    },
  }
  const capture = await correlate(extension, entry, correlation, input)
  check(
    capture.policySHA === request.expected,
    "Original refused index policy differs from the verified committed save",
  )
  const release = await residency(folder, original, downstream)
  const refs = [
    ...files.map((file, index) => ({
      path: path.join(folder, `${selected.request}-${index ? "terminal" : "pending"}.json`),
      bytes: file.raw.length,
      sha256: file.digest,
      tuple: file.tuple,
    })),
    {
      path: path.join(folder, `${original.request}-terminal.json`),
      bytes: matches[0].file.raw.length,
      sha256: matches[0].file.digest,
      tuple: matches[0].file.tuple,
    },
    release,
  ]
  await Promise.all(
    refs.map(async (ref) => {
      const file = await image(ref.path, 65536)
      check(
        file.raw.length === ref.bytes && file.digest === ref.sha256 && file.tuple === ref.tuple,
        "Original save or refused index evidence changed",
      )
    }),
  )
  return {
    ...capture,
    debtSHA: fingerprint(debt),
    indexFailure: {
      request: selected.request,
      outcome: terminal.operation_outcome,
      expected: request.expected,
      operations: refs,
      downstream,
      correlation,
      requestSettlement: false,
      indexConfirmed: false,
      replay: false,
    },
  }
}
