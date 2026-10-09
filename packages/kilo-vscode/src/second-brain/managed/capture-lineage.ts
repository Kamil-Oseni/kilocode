import path from "node:path"
import { lstat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import { parse } from "../settings"
import { descriptor, receipt, selection, type Descriptor } from "./descriptor"
import { admission, history, launch } from "./restart"
import { review } from "./generation"

type Entry = { setup: unknown; credential: string; managed?: Descriptor; launch?: unknown }

function object(value: unknown) {
  check(value && typeof value === "object" && !Array.isArray(value), "Capture lineage object required")
  return value as Record<string, unknown>
}

function phase(value: unknown) {
  const row = object(value)
  check(
    ["phase,receipt", "history,phase,receipt"].includes(Object.keys(row).sort().join()) &&
      ["selected", "running", "closed"].includes(String(row.phase)),
    "Original capture lineage phase required",
  )
  return { phase: row.phase, receipt: receipt(row.receipt), history: history(row.history) ?? [] }
}

async function read(cfg: Descriptor, input: unknown, name: string) {
  const ref = receipt(input)
  check(
    normalize(ref.path).startsWith(normalize(cfg.root) + "/") && path.basename(ref.path) === name,
    "Exact capture lineage receipt location required",
  )
  await directory(path.dirname(ref.path))
  const held = await image(ref.path, 65536)
  check(
    held.digest === ref.sha256 && held.raw.length === ref.bytes && held.tuple === ref.tuple,
    "Original capture lineage receipt changed",
  )
  document(held.raw, 65536)
  return { ref, value: object(JSON.parse(held.raw.toString("utf8"))) }
}

async function selected(cfg: Descriptor, closed: Awaited<ReturnType<typeof read>>, phase = "closed") {
  const formats: Record<string, string> = { selected: "selected", running: "originals", closed: "closed" }
  check(
    closed.value.format === "raya.memory.managed.pair." + formats[phase] && closed.value.version === 2,
    "Exact capture lineage phase receipt required",
  )
  const stored = phase === "selected" ? closed : await read(cfg, closed.value.selected, "managed-reservation.json")
  check(
    stored.value.format === "raya.memory.managed.pair.selected" && stored.value.version === 2,
    "Exact capture reservation required",
  )
  check(
    Object.keys(stored.value).sort().join() ===
      [
        "format",
        "version",
        "descriptor",
        "rootIdentity",
        "images",
        "containment",
        ...(Object.hasOwn(stored.value, "predecessor") ? ["predecessor"] : []),
      ]
        .sort()
        .join() &&
      (phase !== "running" || Object.keys(closed.value).sort().join() === "format,originals,selected,version"),
    "Exact capture reservation fields required",
  )
  check(path.dirname(stored.ref.path) === path.dirname(closed.ref.path), "Capture reservation directory differs")
  const managed = descriptor(stored.value.descriptor)
  const root = await lstat(cfg.root, { bigint: true })
  check(
    isDeepStrictEqual(stored.value.rootIdentity, [root.dev, root.ino, root.birthtimeNs].map(String)),
    "Capture lineage root generation differs",
  )
  return { ...stored, managed }
}

async function originals(
  cfg: Descriptor,
  stored: Awaited<ReturnType<typeof read>>,
  selected: ReturnType<typeof receipt>,
) {
  const rows = object(stored.value.originals)
  check(Object.keys(rows).sort().join() === "memory,retrieval", "Exact paired capture originals required")
  const pids = new Set<number>()
  const refs = []
  for (const kind of ["memory", "retrieval"] as const) {
    const proof = await read(cfg, rows[kind], `managed-${kind}-original.json`)
    const identity = object(proof.value.identity)
    check(
      path.dirname(proof.ref.path) === path.dirname(stored.ref.path) &&
        Object.keys(proof.value).sort().join() ===
          "format,identity,imageObservation,kind,nativeFamilyRetirement,selected,version" &&
        proof.value.format === "raya.memory.managed.pair.original" &&
        proof.value.version === 2 &&
        proof.value.kind === kind &&
        isDeepStrictEqual(receipt(proof.value.selected), selected) &&
        proof.value.nativeFamilyRetirement === false &&
        Object.keys(identity).sort().join() === "birth,digest,executable,parent,pid" &&
        Number.isSafeInteger(identity.pid) &&
        Number(identity.pid) > 0 &&
        Number.isSafeInteger(identity.parent) &&
        Number(identity.parent) > 0 &&
        typeof identity.birth === "string" &&
        /^\d+$/.test(identity.birth) &&
        typeof identity.executable === "string" &&
        normalize(identity.executable) === normalize(cfg.python.path) &&
        identity.digest === cfg.python.sha256 &&
        !pids.has(Number(identity.pid)),
      "Original capture producer selection differs",
    )
    pids.add(Number(identity.pid))
    refs.push(proof.ref)
  }
  return refs
}

/** Prove exact namespace projections after a closed capture, never source or live-owner adoption. */
export async function successors(previous: Entry, current: Entry, input: unknown) {
  const setup = parse(previous.setup)
  check(
    isDeepStrictEqual(previous.setup, current.setup) && previous.credential === current.credential,
    "Capture successor changed the original setup or credential",
  )
  const base = descriptor(previous.managed)
  const target = descriptor(current.managed)
  const before = phase(previous.launch)
  const after = phase(current.launch)
  check(before.phase === "running" || before.phase === "closed", "Original capture producer or closure required")
  const anchor = await read(base, input, "managed-closed.json")
  check(
    isDeepStrictEqual(before.receipt, before.phase === "closed" ? anchor.ref : receipt(anchor.value.original)),
    "Recovered capture closure belongs to another original launch",
  )
  let context = await launch(base, setup, anchor.ref)
  const initial = await selected(base, anchor)
  check(isDeepStrictEqual(initial.managed, base), "Capture anchor descriptor differs")
  const original = await read(base, anchor.value.original, "managed-original.json")
  const retained = [anchor.ref, initial.ref, original.ref, ...(await originals(base, original, initial.ref))]
  const prefix = [...before.history, anchor.ref]
  const refs = [...after.history, after.receipt]
  check(
    refs.length >= prefix.length &&
      new Set(refs.map((ref) => ref.sha256)).size === refs.length &&
      isDeepStrictEqual(refs.slice(0, prefix.length), prefix) &&
      refs.length - prefix.length <= 32,
    "Exact bounded capture successor history prefix required",
  )
  const inputs = await selection(base, setup)
  const observations = [initial]
  const verify = async (stored: Awaited<ReturnType<typeof selected>>) => {
    const observed = await selection(stored.managed, setup)
    check(
      isDeepStrictEqual(
        stored.value.images,
        observed.files.map((item, index) => ({
          ref: [stored.managed.python, stored.managed.supervisor, stored.managed.plan, stored.managed.retrieval][index],
          sha256: item.digest,
          tuple: item.tuple,
        })),
      ),
      "Capture lineage selected images changed",
    )
  }
  await verify(initial)
  check(
    isDeepStrictEqual(
      initial.value.predecessor === undefined ? undefined : receipt(initial.value.predecessor),
      before.history.at(-1),
    ),
    "Original capture history predecessor differs",
  )
  let prior = base
  const names: Record<string, string> = {
    selected: "managed-reservation.json",
    running: "managed-original.json",
    closed: "managed-closed.json",
  }
  for (const [index, ref] of refs.slice(prefix.length).entries()) {
    const state = index === refs.length - prefix.length - 1 ? String(after.phase) : "closed"
    const closed = await read(base, ref, names[state])
    const next = await selected(base, closed, state)
    await admission(prior, context, next.ref, next.managed)
    const original = prior === base ? inputs : await selection(prior, setup)
    await review(prior, context, next.managed, original.files)
    await verify(next)
    if (state === "running") retained.push(...(await originals(next.managed, closed, next.ref)))
    if (state === "closed") context = await launch(next.managed, setup, ref)
    retained.push(closed.ref, next.ref)
    observations.push(next)
    prior = next.managed
  }
  check(isDeepStrictEqual(prior, target), "Current capture differs from exact successor projection")
  for (const stored of observations) await verify(stored)
  for (const ref of retained) await read(base, ref, path.basename(ref.path))
  return Object.freeze({
    generations: refs.length - prefix.length,
    anchor: anchor.ref,
    requestSettlement: false,
    replay: false,
  })
}
