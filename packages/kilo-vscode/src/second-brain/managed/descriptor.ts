import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { document, child, check } from "../control/frames"
import { image, directory, normalize } from "../control/identity"
import { release } from "../control/catalog-v2"
import type { Setup } from "../settings"
import { interpreter, supervisor, retrieval as release7 } from "./catalog"

type Ref = Readonly<{ path: string; bytes: number; sha256: string }>
type Notes = Readonly<{ root: string; system: string; generations: Readonly<Record<string, readonly string[]>> }>
type Space = Readonly<{ root: string; sid: string; generations: Readonly<Record<string, readonly string[]>> }>
export type Descriptor = Readonly<{
  format: "raya.memory.managed.launch"
  version: 1 | 2
  retrieval?: Ref
  python: Ref
  supervisor: Ref
  plan: Ref
  root: string
  namespaces: Readonly<{ memory: Space; retrieval: Space }>
  notes?: Notes
}>

function row(value: unknown) {
  check(value && typeof value === "object" && !Array.isArray(value), "Managed launch object required")
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, names: string[]) {
  check(Object.keys(value).sort().join() === names.sort().join(), "Exact managed launch fields required")
}
function location(value: unknown) {
  check(
    typeof value === "string" && /^[a-z]:[\\/]/i.test(value) && !/[\x00-\x1f]/.test(value) && value.length <= 4096,
    "Canonical Windows launch path required",
  )
  return value
}
function reference(value: unknown): Ref {
  const item = row(value)
  keys(item, ["path", "bytes", "sha256"])
  check(
    Number.isSafeInteger(item.bytes) &&
      Number(item.bytes) > 0 &&
      typeof item.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(item.sha256),
    "Exact launch image required",
  )
  return Object.freeze({ path: location(item.path), bytes: Number(item.bytes), sha256: item.sha256 })
}
function space(value: unknown): Space {
  const item = row(value)
  keys(item, ["root", "sid", "generations"])
  check(typeof item.sid === "string" && /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(item.sid), "Selected Windows owner required")
  const tuples = row(item.generations)
  keys(tuples, ["root", "Runs", "Requests"])
  const generations = tupleset(tuples)
  return Object.freeze({ root: location(item.root), sid: item.sid, generations: Object.freeze(generations) })
}

function tupleset(tuples: Record<string, unknown>) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(tuples).map(([name, value]) => {
        check(
          Array.isArray(value) &&
            value.length === 3 &&
            value.every(
              (item) =>
                typeof item === "string" && /^(0|[1-9]\d{0,19})$/.test(item) && BigInt(item) <= 0xffffffffffffffffn,
            ),
          "Exact namespace integer strings required",
        )
        return [name, Object.freeze([...value] as string[])]
      }),
    ),
  )
}
function witness(value: unknown): Notes {
  const item = row(value)
  keys(item, ["root", "system", "generations"])
  const root = location(item.root)
  const system = location(item.system)
  check(normalize(system) === normalize(path.join(root, "System")), "Selected notes System differs")
  const tuples = row(item.generations)
  keys(tuples, ["root", "system"])
  return Object.freeze({ root, system, generations: tupleset(tuples) })
}

export function descriptor(value: unknown): Descriptor {
  const item = row(value)
  keys(item, [
    "format",
    "version",
    "python",
    "supervisor",
    "plan",
    "root",
    "namespaces",
    ...(Object.hasOwn(item, "notes") ? ["notes"] : []),
    ...(item.version === 2 ? ["retrieval"] : []),
  ])
  check(
    item.format === "raya.memory.managed.launch" && (item.version === 1 || item.version === 2),
    "Managed launch version refused",
  )
  const namespaces = row(item.namespaces)
  keys(namespaces, ["memory", "retrieval"])
  check(
    reference(item.python).sha256 === interpreter && reference(item.supervisor).sha256 === supervisor,
    "Reviewed managed interpreter/supervisor required",
  )
  return Object.freeze({
    format: item.format,
    version: item.version,
    ...(item.version === 2 ? { retrieval: reference(item.retrieval) } : {}),
    python: reference(item.python),
    supervisor: reference(item.supervisor),
    plan: reference(item.plan),
    root: location(item.root),
    namespaces: Object.freeze({ memory: space(namespaces.memory), retrieval: space(namespaces.retrieval) }),
    ...(Object.hasOwn(item, "notes") ? { notes: witness(item.notes) } : {}),
  })
}

export function receipt(value: unknown) {
  const item = row(value)
  keys(item, ["path", "bytes", "sha256", "tuple"])
  const selected = reference({ path: item.path, bytes: item.bytes, sha256: item.sha256 })
  check(
    typeof item.tuple === "string" && /^\d+:\d+:1:\d+:\d+:\d+$/.test(item.tuple),
    "Exact original file tuple required",
  )
  return Object.freeze({ ...selected, tuple: item.tuple })
}

/** Bind only an explicitly selected notes root to the immutable launch plan. */
export async function notes(cfg: Descriptor, plan: Record<string, unknown>, root: string) {
  const env = row(plan.env)
  if (cfg.notes) {
    check(
      isDeepStrictEqual(witness(plan.notes_selection), cfg.notes) && cfg.notes.root === root,
      "Selected notes witness differs",
    )
    await Promise.all([directory(cfg.notes.root), directory(cfg.notes.system)])
    check(typeof env.RAYA_MEMORY_NOTE_GENERATIONS === "string", "Selected notes generation text required")
    const parsed = document(Buffer.from(env.RAYA_MEMORY_NOTE_GENERATIONS))
    keys(row(parsed.value), ["root", "system"])
    for (const name of ["root", "system"]) {
      const node = child(parsed.tree, name)
      check(node.type === "array" && node.children?.length === 3, "Selected notes generation tuple required")
      const tokens = node.children.map((item) => parsed.text.slice(item.offset, item.offset + item.length))
      check(isDeepStrictEqual(tokens, cfg.notes.generations[name]), "Selected notes uint64 generation differs")
    }
    return
  }
  check(!Object.hasOwn(plan, "notes_selection"), "Unselected notes witness refused")
  check(
    normalize(root) === normalize(cfg.root) || normalize(root).startsWith(normalize(cfg.root) + "/"),
    "Notes outside managed root require selection",
  )
}

/** Two independently selected plans share assets but never an HTTP-derived owner. */
export function paired(cfg: Descriptor, memory: Record<string, unknown>, retrieval: Record<string, unknown>) {
  check(cfg.version === 2 && cfg.retrieval, "Explicit paired descriptor required")
  check(
    retrieval.format === "raya.memory.managed.supervisor" &&
      retrieval.version === 1 &&
      retrieval.kind === "retrieval" &&
      retrieval.execution_admitted === true &&
      retrieval.root === cfg.root &&
      retrieval.python_sha256 === cfg.python.sha256 &&
      isDeepStrictEqual({ ...row(retrieval.source_sha256) }, release7),
    "Reviewed Retrieval release differs",
  )
  check(isDeepStrictEqual(memory.files, retrieval.files) && Array.isArray(memory.files), "Paired assets differ")
  check(isDeepStrictEqual(memory.directories, retrieval.directories), "Paired directory generations differ")
  for (const ref of [cfg.python, cfg.supervisor, cfg.plan, cfg.retrieval])
    check(normalize(ref.path).startsWith(normalize(cfg.root) + "/"), "Paired image outside selected root")
  check(cfg.plan.path !== cfg.retrieval.path, "Separate paired plans required")
  const env = row(retrieval.env)
  const original = row(memory.env)
  check(
    Number.isInteger(retrieval.port) &&
      Number(retrieval.port) > 0 &&
      Number(retrieval.port) <= 65535 &&
      retrieval.port !== memory.port &&
      env.RAYA_RETRIEVAL_PORT === String(retrieval.port) &&
      original.RAYA_RETRIEVAL_PORT === String(retrieval.port),
    "Paired ports differ",
  )
  const token = path.join(cfg.root, "tokens", "retrieval.token")
  check(
    env.RAYA_RETRIEVAL_TOKEN_FILE === token && original.RAYA_MEMORY_RETRIEVAL_TOKEN_FILE === token,
    "Selected Retrieval credential path differs",
  )
  check(
    original.RAYA_MEMORY_TOKEN_FILE === path.join(cfg.root, "tokens", "memory.token"),
    "Selected Memory credential path differs",
  )
  const selected = row(memory.retrieval_selection)
  for (const key of ["RAYA_RETRIEVAL_RECEIPT_ROOT", "RAYA_RETRIEVAL_RECEIPT_SID", "RAYA_RETRIEVAL_RECEIPT_GENERATIONS"])
    check(env[key] === selected[key], "Paired original namespace selection differs")
  for (const [kind, plan] of [
    ["memory", memory],
    ["retrieval", retrieval],
  ] as const) {
    check(plan.source === path.join(cfg.root, "source", kind), "Paired source directory differs")
    const hashes = row(plan.source_sha256)
    for (const [name, hash] of Object.entries(hashes)) {
      const candidates = memory.files.filter((value) => row(value).path === path.join(String(plan.source), name))
      check(candidates.length === 1 && row(candidates[0]).sha256 === hash, "Selected paired source file differs")
    }
  }
}

/** Public descriptor selection never reads credential files or derives a namespace from HTTP. */
export async function selection(input: Descriptor, setup: Setup) {
  const cfg = descriptor(input)
  check(setup.version === 2, "Managed Memory requires explicit v2 setup")
  await directory(cfg.root)
  check(path.basename(cfg.root).startsWith("raya-memory-managed-"), "Explicit managed namespace required")
  const refs = [cfg.python, cfg.supervisor, cfg.plan, ...(cfg.version === 2 ? [cfg.retrieval!] : [])]
  const files = await Promise.all(
    refs.map(async (item) => {
      await directory(path.dirname(item.path))
      const value = await image(item.path, item === cfg.python ? 536870912 : 16777216)
      check(value.raw.length === item.bytes && value.digest === item.sha256, "Managed selected image changed")
      return value
    }),
  )
  const decoded = document(files[2].raw, 16777216, 1000000)
  const plan = row(decoded.value)
  check(
    plan.format === "raya.memory.managed.supervisor" &&
      plan.version === 1 &&
      plan.kind === "memory" &&
      plan.execution_admitted === true &&
      plan.root === cfg.root &&
      plan.python_sha256 === cfg.python.sha256 &&
      isDeepStrictEqual({ ...row(plan.source_sha256) }, release) &&
      isDeepStrictEqual(setup.source_sha256, release),
    "Managed plan release differs",
  )
  const env = row(plan.env)
  check(
    env.RAYA_MEMORY_ROOT === setup.root &&
      typeof env.RAYA_MEMORY_PORT === "string" &&
      setup.origin === `http://127.0.0.1:${env.RAYA_MEMORY_PORT}`,
    "Managed service root/origin differs",
  )
  await notes(cfg, plan, setup.root)

  for (const kind of ["memory", "retrieval"] as const) {
    const selected = cfg.namespaces[kind]
    const prefix = kind === "memory" ? "RAYA_MEMORY_OPERATION" : "RAYA_RETRIEVAL_RECEIPT"
    // Retrieval's selected namespace is separate public metadata, never inferred from its service health.
    const source = kind === "memory" ? env : row(plan.retrieval_selection)
    check(
      source[`${prefix}_ROOT`] === selected.root && source[`${prefix}_SID`] === selected.sid,
      "Original namespace selection differs",
    )
    await directory(selected.root)
    check(normalize(selected.root).startsWith(normalize(cfg.root) + "/"), "Namespace outside managed root")
    const raw = source[`${prefix}_GENERATIONS`]
    check(typeof raw === "string", "Original namespace generation text required")
    const parsed = document(Buffer.from(raw))
    const tuples = row(parsed.value)
    keys(tuples, ["root", "Runs", "Requests"])
    for (const name of ["root", "Runs", "Requests"]) {
      const node = child(parsed.tree, name)
      check(node.type === "array" && node.children?.length === 3, "Original generation tuple required")
      const tokens = node.children.map((item) => parsed.text.slice(item.offset, item.offset + item.length))
      check(isDeepStrictEqual(tokens, selected.generations[name]), "Original uint64 generation differs")
    }
  }
  const retrieval = cfg.version === 2 ? row(document(files[3].raw, 16777216, 1000000).value) : undefined
  if (retrieval) paired(cfg, plan, retrieval)
  return Object.freeze({ cfg, plan, files, retrieval })
}
