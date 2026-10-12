import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image, normalize } from "./control/identity"
import { descriptor, receipt } from "./managed/descriptor"
import { parse } from "./settings"
import { journal } from "./journal"
import { fingerprint } from "./failed-repair"

/** Quarantine correlation only: no terminal, publication absence or closure proof. */
export async function inspect(entry: unknown, pending: unknown, witness: ReturnType<typeof receipt>) {
  const saved = object(entry as Parameters<typeof object>[0])
  const setup = parse(saved.setup)
  const cfg = descriptor(saved.managed)
  const prior = object(saved.launch)
  const debt = journal(pending)
  const request = object(debt.request as Parameters<typeof object>[0])
  const original = receipt(prior.receipt)
  check(
    setup.version === 2 &&
      cfg.version === 2 &&
      debt.version === 2 &&
      debt.protocol === setup.protocol &&
      debt.root === setup.root &&
      request.op === "sync" &&
      request.root === setup.root &&
      isDeepStrictEqual(request.source_sha256, setup.source_sha256) &&
      request.selected_release_sha256 === fingerprint(setup.source_sha256) &&
      request.bodySHA === fingerprint({ force_rebuild: false, expected_policy_sha256: request.expected }) &&
      ["running", "closed"].includes(String(prior.phase)) &&
      isDeepStrictEqual(original, witness) &&
      path.basename(original.path) === "managed-original.json" &&
      normalize(original.path).startsWith(normalize(cfg.root) + "/"),
    "Exact uncertain original Sync and pair required",
  )
  await directory(path.dirname(original.path))
  const held = await image(original.path, 65536)
  check(
    held.raw.length === original.bytes && held.digest === original.sha256 && held.tuple === original.tuple,
    "Uncertain Sync original pair changed",
  )
  const pair = object(document(held.raw, 65536).value)
  check(
    pair.format === "raya.memory.managed.pair.originals" && pair.version === 2,
    "Uncertain Sync original paired publication required",
  )
  return { setup, cfg, original, held, selected: { request: String(request.id) }, outcome: "unknown" as const }
}
