import path from "node:path"
import { readdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { directory, image } from "./control/identity"
import { selection, type Descriptor } from "./managed/descriptor"
import { observe } from "./managed/upgrade-observe"
import type { Setup } from "./settings"

/** Retain exact original publications; this grants no HTTP or cold settlement authority. */
export async function retained(cfg: Descriptor, setup: Setup, input: unknown) {
  return publications(cfg, setup, input, false)
}

/** Retain completed publications for quarantine only; never infer worker release. */
export async function finished(cfg: Descriptor, setup: Setup, input: unknown) {
  return publications(cfg, setup, input, true)
}

async function publications(cfg: Descriptor, setup: Setup, input: unknown, completed: boolean) {
  check(Array.isArray(input) && input.length <= 16, "Bounded original downstream list required")
  if (!input.length) return []
  const selected = await selection(cfg, setup)
  check(selected.retrieval, "Selected paired Retrieval required")
  const env = object(selected.retrieval.env as Parameters<typeof object>[0])
  const proofs = []
  for (const item of input) {
    const row = object(item as Parameters<typeof object>[0])
    check(
      row.format === "raya.retrieval.request.settlement" &&
        row.version === 2 &&
        row.phase === "settled" &&
        (completed
          ? row.inference_outcome === "completed" &&
            row.original_process_running === true &&
            row.original_job_membership_observed === true &&
            row.selected_images_unchanged === true
          : row.inference_outcome === "failed" &&
            row.worker_created === false &&
            row.cleanup_outcome === "not_started" &&
            row.joins_observed === false) &&
        row.selected_release_sha256 === env.RAYA_RETRIEVAL_RELEASE_SHA256 &&
        [row.request, row.owner_epoch].every((value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value)),
      "Only exact selected downstream publications may be retained",
    )
    const folder = path.join(cfg.namespaces.retrieval.root, "Requests", String(row.owner_epoch))
    await directory(folder)
    const names = await readdir(folder)
    check(names.length <= 8192, "Original downstream namespace bound exceeded")
    const matches = names.filter((name) => name.startsWith(String(row.request) + "-"))
    check(
      matches.length === 2 && matches.every((name) => /^[a-f0-9]{32}-[a-f0-9]{32}\.json$/.test(name)),
      "Exact original downstream reservation and settlement required",
    )
    const refs = []
    const forms = new Set<string>()
    for (const name of matches.sort()) {
      const file = path.join(folder, name)
      const held = await image(file, 65536)
      const value = object(document(held.raw, 65536).value)
      const pending = {
        format: "raya.retrieval.request.reservation",
        version: 2,
        phase: "pending",
        request: row.request,
        owner_epoch: row.owner_epoch,
        selected_release_sha256: row.selected_release_sha256,
        request_sha256: row.request_sha256,
      }
      check(
        isDeepStrictEqual({ ...value }, pending) || isDeepStrictEqual({ ...value }, { ...row }),
        "Original downstream publication differs",
      )
      check(!forms.has(String(value.phase)), "Duplicate original downstream publication")
      forms.add(String(value.phase))
      refs.push({ path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple })
    }
    // Persist nested worker metadata with ordinary JSON objects so file-backed
    // audit readback preserves the same complete value and prototype contract.
    proofs.push({ request: row.request, receipt: JSON.parse(JSON.stringify(row)) as typeof row, files: refs })
  }
  // The pinned native observer verifies the selected protected namespace and generations.
  await observe(cfg, "", cfg.namespaces)
  return proofs
}
