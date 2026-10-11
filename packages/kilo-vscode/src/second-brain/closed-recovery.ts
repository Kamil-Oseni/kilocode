import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { check, document, object } from "./control/frames"
import { image, directory } from "./control/identity"
import { descriptor, receipt } from "./managed/descriptor"
import { launch } from "./managed/restart"
import { parse } from "./settings"
import { absent as strict } from "./failed-archive"
import { packaged } from "./control/index"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { z } from "zod"

export class ClosedRequired extends Error {}
const reviews = new WeakSet<object>()
const observed = z
  .object({
    status: z.enum(["owned", "gone", "unknown", "foreign"]),
    birth: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .nullable(),
    parent: z.number().int().min(0).max(0xffffffff),
  })
  .strict()

/** Decode and compare evidence only; admission still requires a validated closure and native inspect. */
export function newer(original: string, input: unknown) {
  check(
    /^[1-9]\d{0,19}$/.test(original) && BigInt(original) <= 0xffffffffffffffffn,
    "Original kernel birth identity required",
  )
  const current = observed.parse(input)
  if (current.status === "gone") return current
  check(
    current.status === "owned" &&
      current.birth &&
      current.parent > 0 &&
      BigInt(current.birth) <= 0xffffffffffffffffn &&
      BigInt(current.birth) > BigInt(original),
    "Original producer remains present or its kernel identity is unverified",
  )
  return current
}

/** A genuine pair closure permits fresh admission; it never settles request debt. */
export async function review(entry: { setup: unknown; managed?: unknown; launch?: unknown }) {
  const setup = parse(entry.setup)
  const cfg = descriptor(entry.managed)
  const prior = object(entry.launch as Parameters<typeof object>[0])
  check(
    setup.version === 2 && cfg.version === 2 && ["running", "closed"].includes(String(prior.phase)),
    "Saved running or closed pair required",
  )
  const saved = receipt(prior.receipt)
  const file = prior.phase === "closed" ? saved.path : path.join(path.dirname(saved.path), "managed-closed.json")
  check(path.basename(file) === "managed-closed.json", "Original closed receipt required")
  await directory(path.dirname(file))
  const held = await image(file, 65536)
  const closed = Object.freeze({ path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple })
  const value = object(document(held.raw, 65536).value)
  if (prior.phase === "closed") check(isDeepStrictEqual(closed, saved), "Saved closure changed")
  const original = prior.phase === "closed" ? receipt(value.original) : saved
  check(path.basename(original.path) === "managed-original.json", "Original paired receipt required")
  check(isDeepStrictEqual(receipt(value.original), original), "Closed pair differs from saved original")
  await launch(cfg, setup, closed)
  const before = await image(original.path, 65536)
  check(
    before.raw.length === original.bytes && before.digest === original.sha256 && before.tuple === original.tuple,
    "Saved original pair changed",
  )
  const pair = object(object(document(before.raw, 65536).value).originals)
  const pids = new Set<number>()
  const identities: { pid: number; parent: number; birth: string }[] = []
  for (const kind of ["memory", "retrieval"]) {
    const ref = receipt(pair[kind])
    const held = await image(ref.path, 65536)
    check(
      held.raw.length === ref.bytes && held.digest === ref.sha256 && held.tuple === ref.tuple,
      "Original identity changed",
    )
    const identity = object(object(document(held.raw, 65536).value).identity)
    check(
      typeof identity.birth === "string" &&
        /^[1-9]\d{0,19}$/.test(identity.birth) &&
        BigInt(identity.birth) <= 0xffffffffffffffffn,
      "Original kernel birth identity required",
    )
    identities.push(
      Object.freeze({ pid: Number(identity.pid), parent: Number(identity.parent), birth: identity.birth }),
    )
    pids.add(Number(identity.pid))
    pids.add(Number(identity.parent))
  }
  const result = Object.freeze({
    root: setup.root,
    original,
    closed,
    pids: Object.freeze([...pids].sort((a, b) => a - b)),
    identities: Object.freeze(identities),
    ports: Object.freeze([Number(new URL(setup.origin).port)]),
  })
  reviews.add(result)
  return result
}

/** Inspect only: a newer producer birth is unrelated; unqualified parent PIDs remain strict. */
export async function absent(input: Awaited<ReturnType<typeof review>>, extension?: string) {
  check(reviews.has(input), "Original validated closed-pair review required")
  if (!extension) return strict(input)
  const helper = await packaged(extension)
  const parents = new Set(input.identities.map((row) => row.parent))
  const reused: { pid: number; original: string; current: z.infer<typeof observed> }[] = []
  for (const identity of input.identities) {
    const current = newer(identity.birth, await NativeProcess.inspect(identity.pid, helper.helper))
    if (current.status === "gone") continue
    check(!parents.has(identity.pid), "Unqualified original parent PID remains strict")
    reused.push({ pid: identity.pid, original: identity.birth, current })
  }
  const pids = input.pids.filter((pid) => !reused.some((row) => row.pid === pid))
  const result = await strict({ pids, ports: input.ports })
  for (const identity of reused) {
    const current = observed.parse(await NativeProcess.inspect(identity.pid, helper.helper))
    check(
      current.status === "gone" ||
        (current.status === "owned" &&
          current.birth === identity.current.birth &&
          current.parent === identity.current.parent),
      "Observed reused producer PID changed during admission",
    )
  }
  return Object.freeze({
    ...result,
    pids: input.pids,
    observedPids: pids,
    identities: input.identities,
    reused,
    nativeHelper: { path: helper.helper, sha256: helper.digest },
    qualification:
      "Current original kernel-identity/listener absence only; historical closure remains independently validated",
  })
}
