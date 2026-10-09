import path from "node:path"
import { lstat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, document } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import type { Setup } from "../settings"
import { descriptor, receipt, selection, type Descriptor } from "./descriptor"
import { launch, admission, history } from "./restart"
import { review } from "./generation"

type Phase = {
  phase: "selected" | "running" | "closed"
  receipt: ReturnType<typeof receipt>
  history?: ReturnType<typeof receipt>[]
}

function object(input: unknown) {
  check(input && typeof input === "object" && !Array.isArray(input), "Runtime lineage object required")
  return input as Record<string, unknown>
}

async function read(cfg: Descriptor, input: unknown) {
  const ref = receipt(input)
  check(normalize(ref.path).startsWith(normalize(cfg.root) + "/"), "Lineage receipt outside selected root")
  await directory(path.dirname(ref.path))
  const selected = await image(ref.path, 65536)
  check(
    selected.digest === ref.sha256 && selected.raw.length === ref.bytes && selected.tuple === ref.tuple,
    "Runtime lineage receipt changed",
  )
  document(selected.raw, 65536)
  return { ref, value: object(JSON.parse(selected.raw.toString("utf8"))) }
}

async function reservation(cfg: Descriptor, input: unknown, phase: Phase["phase"]) {
  const stored = await read(cfg, input)
  const names = {
    selected: "managed-reservation.json",
    running: "managed-original.json",
    closed: "managed-closed.json",
  }
  const formats = { selected: "selected", running: "originals", closed: "closed" }
  check(
    path.basename(stored.ref.path) === names[phase] &&
      stored.value.version === 2 &&
      stored.value.format === "raya.memory.managed.pair." + formats[phase],
    "Exact runtime lineage phase receipt required",
  )
  const selected = phase === "selected" ? stored : await read(cfg, stored.value.selected)
  check(
    path.basename(selected.ref.path) === names.selected &&
      path.dirname(selected.ref.path) === path.dirname(stored.ref.path) &&
      selected.value.format === "raya.memory.managed.pair.selected" &&
      selected.value.version === 2,
    "Runtime lineage reservation differs",
  )
  const managed = descriptor(selected.value.descriptor)
  const root = await lstat(cfg.root, { bigint: true })
  check(
    isDeepStrictEqual(selected.value.rootIdentity, [root.dev, root.ino, root.birthtimeNs].map(String)),
    "Runtime lineage root witness differs",
  )
  return { ...selected, managed }
}

/** Read-only lineage proves exact plan projection for every retained successor; it grants no live-process authority. */
export async function lineage(base: Descriptor, setup: Setup, current: Descriptor, input: unknown) {
  if (input === undefined) {
    check(isDeepStrictEqual(current, base), "Unstarted runtime upgrade descriptor differs")
    return Object.freeze({ generations: 0, requestSettlement: false, replay: false })
  }
  const value = object(input)
  check(
    ["phase,receipt", "history,phase,receipt"].includes(Object.keys(value).sort().join()) &&
      ["selected", "running", "closed"].includes(String(value.phase)),
    "Exact runtime lineage launch required",
  )
  const phase = value.phase as Phase["phase"]
  const refs = [...(history(value.history) ?? []), receipt(value.receipt)]
  let previous = base
  let context = await launch(previous, setup)
  for (const [index, ref] of refs.entries()) {
    const state = index === refs.length - 1 ? phase : "closed"
    const selected = await reservation(base, ref, state)
    await admission(previous, context, selected.ref, selected.managed)
    const before = await selection(previous, setup)
    await review(previous, context, selected.managed, before.files)
    const observed = await selection(selected.managed, setup)
    check(
      isDeepStrictEqual(
        selected.value.images,
        observed.files.map((item, index) => ({
          ref: [
            selected.managed.python,
            selected.managed.supervisor,
            selected.managed.plan,
            selected.managed.retrieval,
          ][index],
          sha256: item.digest,
          tuple: item.tuple,
        })),
      ),
      "Runtime lineage selected images changed",
    )
    if (state === "closed") context = await launch(selected.managed, setup, ref)
    previous = selected.managed
  }
  check(isDeepStrictEqual(previous, current), "Current runtime differs from reviewed successor lineage")
  return Object.freeze({ generations: refs.length, requestSettlement: false, replay: false })
}
