import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { image, directory } from "./control/identity"
import { descriptor, receipt } from "./managed/descriptor"
import { launch } from "./managed/restart"
import { parse } from "./settings"

export class ClosedRequired extends Error {}

/** A genuine pair closure permits fresh admission; it never settles request debt. */
export async function review(entry: { setup: unknown; managed?: unknown; launch?: unknown }) {
  const setup = parse(entry.setup)
  const cfg = descriptor(entry.managed)
  const prior = object(entry.launch as Parameters<typeof object>[0])
  check(setup.version === 2 && cfg.version === 2 && prior.phase === "running", "Saved running pair required")
  const original = receipt(prior.receipt)
  check(path.basename(original.path) === "managed-original.json", "Original paired receipt required")
  const file = path.join(path.dirname(original.path), "managed-closed.json")
  await directory(path.dirname(file))
  const held = await image(file, 65536)
  const closed = { path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }
  const value = object(document(held.raw, 65536).value)
  check(isDeepStrictEqual(receipt(value.original), original), "Closed pair differs from saved original")
  await launch(cfg, setup, closed)
  const before = await image(original.path, 65536)
  check(
    before.raw.length === original.bytes && before.digest === original.sha256 && before.tuple === original.tuple,
    "Saved original pair changed",
  )
  const pair = object(object(document(before.raw, 65536).value).originals)
  const pids = new Set<number>()
  for (const kind of ["memory", "retrieval"]) {
    const ref = receipt(pair[kind])
    const held = await image(ref.path, 65536)
    check(
      held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
      "Original identity changed",
    )
    const identity = object(object(document(held.raw, 65536).value).identity)
    pids.add(Number(identity.pid))
    pids.add(Number(identity.parent))
  }
  return Object.freeze({
    root: setup.root,
    original,
    closed,
    pids: [...pids].sort((a, b) => a - b),
    ports: [Number(new URL(setup.origin).port)],
  })
}
