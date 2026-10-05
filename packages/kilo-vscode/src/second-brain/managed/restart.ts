import path from "node:path"
import { lstat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, sha } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import { descriptor, receipt, type Descriptor } from "./descriptor"
import type { Setup } from "../settings"
import type { Receipt } from "./owner"

export type Launch = Readonly<{ root: string; predecessor?: Receipt }>

function row(value: unknown) {
  check(value && typeof value === "object" && !Array.isArray(value), "Managed restart object required")
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, names: string[]) {
  check(Object.keys(value).sort().join() === names.sort().join(), "Exact managed restart fields required")
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

function location(cfg: Descriptor, file: string) {
  check(normalize(file).startsWith(normalize(cfg.root) + "/"), "Managed restart receipt outside selected root")
}

async function read(cfg: Descriptor, input: unknown) {
  const ref = receipt(input)
  location(cfg, ref.path)
  await directory(path.dirname(ref.path))
  const value = await image(ref.path, 65536)
  check(
    value.raw.length === ref.bytes && value.digest === ref.sha256 && value.tuple === ref.tuple,
    "Original managed receipt changed",
  )
  return { ref, value: row(document(value.raw, 65536).value) }
}

function closure(value: unknown) {
  const item = row(value)
  keys(item, [
    "pid",
    "code",
    "signal",
    "eof",
    "bytes",
    "readersJoined",
    "originalJoined",
    "forced",
    "producerRetirement",
    "preStartRetirement",
    "nativeFamilyRetirement",
    "coldSettlementAuthority",
  ])
  check(
    Number.isSafeInteger(item.pid) && Number(item.pid) > 0 && item.code === 0 && item.signal === null,
    "Original managed exit required",
  )
  const eof = row(item.eof)
  const bytes = row(item.bytes)
  keys(eof, ["stdout", "stderr"])
  keys(bytes, ["stdout", "stderr"])
  check(
    eof.stdout === true &&
      eof.stderr === true &&
      Object.values(bytes).every(
        (value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1048576,
      ),
    "Original managed readers required",
  )
  check(
    item.readersJoined === true &&
      item.originalJoined === true &&
      item.producerRetirement === true &&
      item.forced === false &&
      item.preStartRetirement === false &&
      item.nativeFamilyRetirement === false &&
      item.coldSettlementAuthority === false,
    "Clean original managed producer closure required",
  )
  return item
}

/** A closed host pair permits a fresh launch selection, never adoption or debt settlement. */
export async function launch(input: Descriptor, setup: Setup, previous?: unknown): Promise<Launch> {
  const cfg = descriptor(input)
  check(cfg.version === 2 && setup.version === 2, "Explicit paired restart selection required")
  const base = path.join(cfg.namespaces.memory.root, "Runs")
  location(cfg, base)
  if (previous === undefined) {
    const key = sha(Buffer.from(JSON.stringify(canonical(["raya.memory.managed.first", cfg, setup])))).slice(0, 32)
    return Object.freeze({ root: path.join(base, key) })
  }
  await directory(base)
  return complete(cfg, base, previous)
}

async function complete(cfg: Descriptor, base: string, previous: unknown): Promise<Launch> {
  const closed = await read(cfg, previous)
  check(path.basename(closed.ref.path) === "managed-closed.json", "Original closed receipt location required")
  keys(closed.value, ["format", "version", "selected", "original", "closures", "qualification"])
  check(
    closed.value.format === "raya.memory.managed.pair.closed" &&
      closed.value.version === 2 &&
      typeof closed.value.qualification === "string",
    "Original paired closure protocol required",
  )
  const before = await read(cfg, closed.value.selected)
  const original = await read(cfg, closed.value.original)
  const folder = path.dirname(closed.ref.path)
  check(
    path.dirname(before.ref.path) === folder &&
      path.basename(before.ref.path) === "managed-reservation.json" &&
      path.dirname(original.ref.path) === folder &&
      path.basename(original.ref.path) === "managed-original.json",
    "Original paired receipt directory differs",
  )
  await selected(cfg, before, closed.ref)
  keys(original.value, ["format", "version", "selected", "originals"])
  check(
    original.value.format === "raya.memory.managed.pair.originals" &&
      original.value.version === 2 &&
      isDeepStrictEqual(receipt(original.value.selected), before.ref),
    "Original paired aggregate differs",
  )
  const originals = row(original.value.originals)
  const closures = row(closed.value.closures)
  keys(originals, ["memory", "retrieval"])
  keys(closures, ["memory", "retrieval"])
  const pids = new Set<number>()
  for (const kind of ["memory", "retrieval"] as const) {
    const proof = await read(cfg, originals[kind])
    check(
      path.dirname(proof.ref.path) === folder && path.basename(proof.ref.path) === `managed-${kind}-original.json`,
      "Original native receipt directory differs",
    )
    keys(proof.value, [
      "format",
      "version",
      "kind",
      "selected",
      "identity",
      "imageObservation",
      "nativeFamilyRetirement",
    ])
    check(
      proof.value.format === "raya.memory.managed.pair.original" &&
        proof.value.version === 2 &&
        proof.value.kind === kind &&
        isDeepStrictEqual(receipt(proof.value.selected), before.ref) &&
        proof.value.nativeFamilyRetirement === false,
      "Original native selection differs",
    )
    const identity = native(cfg, proof.value.identity)
    const ended = closure(closures[kind])
    check(ended.pid === identity.pid && !pids.has(Number(identity.pid)), "Original paired closure identity differs")
    pids.add(Number(identity.pid))
  }
  const key = sha(Buffer.from("raya.memory.managed.successor:" + closed.ref.sha256)).slice(0, 32)
  const parent = normalize(folder) === normalize(cfg.root) ? base : path.dirname(folder)
  if (normalize(folder) !== normalize(cfg.root))
    check(
      /^[a-f0-9]{32}$/.test(path.basename(folder)) && path.basename(parent) === "Runs",
      "Original managed launch namespace differs",
    )
  await directory(parent)
  return Object.freeze({ root: path.join(parent, key), predecessor: closed.ref })
}

async function selected(cfg: Descriptor, before: Awaited<ReturnType<typeof read>>, ended: Receipt) {
  keys(before.value, [
    "format",
    "version",
    "descriptor",
    "rootIdentity",
    "images",
    "containment",
    ...(Object.hasOwn(before.value, "predecessor") ? ["predecessor"] : []),
  ])
  if (Object.hasOwn(before.value, "predecessor")) {
    const prior = receipt(before.value.predecessor)
    location(cfg, prior.path)
    check(prior.sha256 !== ended.sha256, "Managed restart predecessor repeats")
  }
  check(
    before.value.format === "raya.memory.managed.pair.selected" &&
      before.value.version === 2 &&
      isDeepStrictEqual(descriptor(before.value.descriptor), cfg),
    "Original paired descriptor differs",
  )
  check(
    Array.isArray(before.value.rootIdentity) &&
      before.value.rootIdentity.length === 3 &&
      before.value.rootIdentity.every(
        (value) =>
          typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn,
      ),
    "Original root identity required",
  )
  const root = await lstat(cfg.root, { bigint: true })
  check(
    isDeepStrictEqual(before.value.rootIdentity, [root.dev, root.ino, root.birthtimeNs].map(String)),
    "Original managed root generation differs",
  )
  const refs = [cfg.python, cfg.supervisor, cfg.plan, cfg.retrieval]
  check(Array.isArray(before.value.images) && before.value.images.length === 4, "Original selected images required")
  for (const [index, value] of before.value.images.entries()) {
    const item = row(value)
    keys(item, ["ref", "sha256", "tuple"])
    check(
      isDeepStrictEqual({ ...row(item.ref) }, refs[index]) &&
        item.sha256 === refs[index]!.sha256 &&
        typeof item.tuple === "string" &&
        /^\d+:\d+:1:\d+:\d+:\d+$/.test(item.tuple),
      "Original selected image differs",
    )
  }
}

function native(cfg: Descriptor, value: unknown) {
  const identity = row(value)
  keys(identity, ["pid", "birth", "parent", "executable", "digest"])
  check(
    Number.isSafeInteger(identity.pid) &&
      Number(identity.pid) > 0 &&
      Number.isSafeInteger(identity.parent) &&
      Number(identity.parent) > 0 &&
      typeof identity.birth === "string" &&
      /^\d+$/.test(identity.birth) &&
      typeof identity.executable === "string" &&
      normalize(identity.executable) === normalize(cfg.python.path) &&
      identity.digest === cfg.python.sha256,
    "Original native identity differs",
  )
  return identity
}

export async function admission(cfg: Descriptor, launch: Launch | undefined, proof: Receipt, managed?: Descriptor) {
  if (managed && (!launch || cfg.version !== 2)) throw new Error("Original restart selection required")
  const selected = managed ? descriptor(managed) : cfg
  if (managed) {
    if (!isDeepStrictEqual({ ...managed, plan: cfg.plan, retrieval: cfg.retrieval, namespaces: cfg.namespaces }, cfg))
      throw new Error("Restart changed immutable service selection")
    for (const kind of ["memory", "retrieval"] as const)
      if (
        normalize(managed.namespaces[kind].root) !== normalize(path.join(launch!.root, kind)) ||
        managed.namespaces[kind].sid !== cfg.namespaces[kind].sid
      )
        throw new Error("Fresh restart namespace differs")
    for (const ref of [managed.plan, managed.retrieval!])
      if (!normalize(ref.path).startsWith(normalize(launch!.root) + "/"))
        throw new Error("Fresh restart plan outside selected generation")
    await publication(launch!, proof, managed)
  }
  return selected
}

async function publication(launch: Launch, proof: Receipt, managed: Descriptor) {
  check(
    normalize(path.dirname(proof.path)) === normalize(launch.root) &&
      path.basename(proof.path) === "managed-reservation.json",
    "Selected restart publication location differs",
  )
  await directory(launch.root)
  const value = await image(proof.path, 65536)
  check(
    value.digest === proof.sha256 && value.raw.length === proof.bytes && value.tuple === proof.tuple,
    "Restart selected publication changed",
  )
  const data = row(document(value.raw, 65536).value)
  check(
    data.format === "raya.memory.managed.pair.selected" &&
      data.version === 2 &&
      isDeepStrictEqual(descriptor(data.descriptor), managed) &&
      isDeepStrictEqual(data.predecessor === undefined ? undefined : receipt(data.predecessor), launch.predecessor),
    "Restart selected provenance differs",
  )
}

export function transition(prior: string | undefined, phase: string, launch?: Launch, previous?: Receipt) {
  if (phase === "selected" && prior === "closed") {
    check(
      launch?.predecessor && isDeepStrictEqual(launch.predecessor, previous),
      "Original closed restart selection required",
    )
    return true
  }
  const allowed: Record<string, readonly (string | undefined)[]> = {
    selected: [undefined],
    running: ["selected"],
    closed: ["running"],
    uncertain: ["selected", "running"],
  }
  check(allowed[phase]?.includes(prior), "Original managed phase cannot be replayed or replaced")
  return false
}

export function history(value: unknown, previous?: Receipt) {
  if (value === undefined && previous === undefined) return undefined
  check(
    value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= 256),
    "Invalid managed history",
  )
  const items = (value === undefined ? [] : (value as unknown[])).map(receipt)
  if (previous) items.push(receipt(previous))
  check(
    items.length <= 256 && new Set(items.map((item) => item.sha256)).size === items.length,
    "Managed history exceeds bound or repeats",
  )
  return items
}
