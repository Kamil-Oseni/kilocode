import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { check, child, document } from "../control/frames"
import { directory, image } from "../control/identity"
import { release } from "../control/catalog-capture"
import { parse, type Setup } from "../settings"
import { fingerprint } from "../failed-repair"
import { descriptor, selection, type Descriptor } from "./descriptor"
import { protection } from "./protection"
import { observe } from "./upgrade-observe"
import { project } from "./upgrade"
import { project as namespace } from "./generation"
import type { materialize } from "./materialize"

type Prepared = Awaited<ReturnType<typeof materialize>>
type Entry = { setup: Setup; managed: Descriptor }

function entry(input: unknown): Entry {
  check(input && typeof input === "object" && !Array.isArray(input), "Selected upgrade entry required")
  const value = input as Record<string, unknown>
  check(Object.keys(value).sort().join() === "managed,setup", "Exact upgrade entry required")
  return { setup: parse(value.setup), managed: descriptor(value.managed) }
}

function producer(input: Prepared["producer"]) {
  check(
    input &&
      Number.isSafeInteger(input.pid) &&
      Number(input.pid) > 0 &&
      input.code === 0 &&
      input.signal === null &&
      input.stdoutEOF === true &&
      input.stderrEOF === true &&
      input.originalJoined === true &&
      input.readersJoined === true &&
      input.forced === false &&
      input.observationExpired === false &&
      Number.isSafeInteger(input.stdoutBytes) &&
      input.stdoutBytes > 0 &&
      input.stdoutBytes <= 65536 &&
      input.stderrBytes === 0,
    "Original upgrade helper closure required",
  )
}

function metadata(value: Omit<Prepared, "receipt">, prior: Entry, id: string) {
  check(
    Object.keys(value).sort().join() ===
      [
        "format",
        "version",
        "id",
        "previous",
        "next",
        "source",
        "original",
        "images",
        "directory",
        "spaces",
        "producer",
        "programSHA",
        "requestSettlement",
        "replay",
        "indexConfirmed",
      ]
        .sort()
        .join() &&
      value.format === "raya.memory.runtime.upgrade.prepared" &&
      value.version === 1 &&
      value.id === id &&
      value.requestSettlement === false &&
      value.replay === false &&
      value.indexConfirmed === false,
    "Exact prepared upgrade metadata required",
  )
  const previous = entry(value.previous)
  const next = entry(value.next)
  check(
    isDeepStrictEqual(previous, prior) && isDeepStrictEqual(next.setup, { ...prior.setup, source_sha256: release }),
    "Reviewed old/new setup linkage differs",
  )
  return next
}

function runtime(value: Omit<Prepared, "receipt">, prior: Entry, next: Entry, folder: string) {
  check(
    next.managed.root === prior.managed.root &&
      next.managed.version === 2 &&
      isDeepStrictEqual(next.managed.python, prior.managed.python) &&
      isDeepStrictEqual(next.managed.notes, prior.managed.notes) &&
      next.managed.plan.path === path.join(folder, "memory-plan.json") &&
      next.managed.retrieval?.path === path.join(folder, "retrieval-plan.json") &&
      value.source === path.join(prior.managed.root, "raya-memory-source-upgrade-" + value.id) &&
      next.managed.supervisor.path === path.join(value.source, "supervise.py"),
    "Exact derived runtime linkage required",
  )
  check(
    next.managed.namespaces.memory.root === path.join(folder, "memory") &&
      next.managed.namespaces.retrieval.root === path.join(folder, "retrieval") &&
      Object.values(next.managed.namespaces).every((space) => space.sid === prior.managed.namespaces.memory.sid),
    "Selected fresh upgrade namespaces differ",
  )
}

/** Reconstruct both derived plans from the retained originals; inspect native code/ACLs/spaces without changing saved state. */
export async function review(input: Descriptor["plan"], expected: Entry) {
  const prior = entry(expected)
  const ref = descriptor({ ...prior.managed, plan: input }).plan
  const folder = path.dirname(ref.path)
  const id = path.basename(folder).slice("raya-memory-fresh-".length)
  check(
    path.dirname(folder) === prior.managed.root &&
      path.basename(folder) === "raya-memory-fresh-" + id &&
      /^[a-f0-9]{32}$/.test(id) &&
      path.basename(ref.path) === "upgrade-prepared.json",
    "Selected immutable upgrade receipt required",
  )
  await directory(folder)
  const held = await image(ref.path, 65536)
  check(held.raw.length === ref.bytes && held.digest === ref.sha256, "Prepared upgrade receipt changed")
  document(held.raw, 65536)
  // Prepared metadata stores all native identities as decimal strings; only plans retain raw integer tokens.
  const value = JSON.parse(held.raw.toString("utf8")) as Omit<Prepared, "receipt">
  const next = metadata(value, prior, id)
  runtime(value, prior, next, folder)
  producer(value.producer)
  const sid = await protection(prior.managed.root)
  check(
    sid === prior.managed.namespaces.memory.sid && sid === prior.managed.namespaces.retrieval.sid,
    "Selected upgrade owner differs",
  )
  const original = await selection(prior.managed, prior.setup)
  const selected = await selection(next.managed, next.setup)
  const observed = await observe(prior.managed, value.source, next.managed.namespaces)
  check(
    observed.programSHA === value.programSHA &&
      isDeepStrictEqual(observed.prior, value.original) &&
      isDeepStrictEqual(observed.images, value.images) &&
      isDeepStrictEqual(observed.directory, value.directory) &&
      isDeepStrictEqual(observed.spaces, value.spaces) &&
      observed.directory,
    "Prepared native upgrade evidence changed",
  )
  check(typeof original.plan.source === "string", "Original source location required")
  const replacements = new Map(
    observed.images
      .filter((item) => path.basename(item.path) !== "supervise.py")
      .map((item) => [path.join(String(original.plan.source), path.basename(item.path)), item]),
  )
  const supervisor = observed.images.find((item) => path.basename(item.path) === "supervise.py")
  check(supervisor, "Observed current supervisor required")
  const base = { path: original.plan.source, pins: prior.setup.source_sha256 }
  const plans = [2, 3].map((index) =>
    project(original.files[index].raw, value.source, release, replacements, supervisor, observed.directory!, base),
  )
  const parsed = document(plans[0], 16777216, 1000000)
  const node = child(parsed.tree, "directories")
  const dirs = parsed.text.slice(node.offset, node.offset + node.length)
  const additions = observed.spaces.map(
    (item) => '{"path":' + JSON.stringify(item.path) + ',"identity":[' + item.identity.join(",") + "]}",
  )
  const projected = dirs.slice(0, -1) + (node.children?.length ? "," : "") + additions.join(",") + "]"
  for (const [index, kind] of ["memory", "retrieval"].entries())
    check(
      namespace(plans[index], kind as "memory" | "retrieval", next.managed.namespaces, projected).equals(
        selected.files[index + 2].raw,
      ),
      "Derived upgrade plan changed unrelated original bytes",
    )
  const after = await image(ref.path, 65536)
  check(after.tuple === held.tuple && after.digest === held.digest, "Prepared upgrade receipt rebound")
  return Object.freeze({
    ...value,
    previous: prior,
    next,
    receipt: ref,
    reviewSHA: fingerprint({ ...value, producer: undefined }),
    producer: observed.producer,
  })
}
