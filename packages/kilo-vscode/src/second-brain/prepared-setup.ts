import path from "node:path"
import { metadata } from "./manifest"
import { parse } from "./settings"
import { descriptor, selection } from "./managed/descriptor"
import { parseCatalog } from "./control/catalog"
import { check } from "./control/frames"
import { image } from "./control/identity"

type Ref = { path: string; bytes: number; sha256: string }
type Bundle = {
  format: "raya.memory.prepared.setup"
  version: 1
  setup?: Ref
  managed?: Ref
  fresh?: Ref
  control: Ref
  capture?: Ref
}

function ref(input: unknown): Ref {
  check(input && typeof input === "object" && !Array.isArray(input), "Prepared Memory reference required")
  const row = input as Record<string, unknown>
  check(Object.keys(row).sort().join() === "bytes,path,sha256", "Exact prepared Memory reference required")
  check(
    typeof row.path === "string" &&
      path.isAbsolute(row.path) &&
      !/^(?:\\\\|\/\/)/.test(row.path) &&
      !/[\x00-\x1f]/.test(row.path) &&
      row.path.length <= 4096 &&
      Number.isSafeInteger(row.bytes) &&
      Number(row.bytes) > 0 &&
      Number(row.bytes) <= 16384 &&
      typeof row.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(row.sha256),
    "Bounded local prepared Memory reference required",
  )
  return { path: row.path, bytes: Number(row.bytes), sha256: row.sha256 }
}

export function bundle(input: unknown): Bundle {
  check(input && typeof input === "object" && !Array.isArray(input), "Prepared Memory bundle required")
  const row = input as Record<string, unknown>
  check(
    row.format === "raya.memory.prepared.setup" &&
      row.version === 1 &&
      Object.keys(row).every((key) =>
        ["format", "version", "setup", "managed", "fresh", "control", "capture"].includes(key),
      ) &&
      (row.fresh !== undefined
        ? row.setup === undefined && row.managed === undefined
        : row.setup !== undefined && row.managed !== undefined),
    "Exact prepared Memory bundle required",
  )
  return {
    format: "raya.memory.prepared.setup",
    version: 1,
    ...(row.fresh !== undefined ? { fresh: ref(row.fresh) } : { setup: ref(row.setup), managed: ref(row.managed) }),
    control: ref(row.control),
    ...(row.capture !== undefined ? { capture: ref(row.capture) } : {}),
  }
}

export async function pinned<T>(ref: Ref, decode: (input: unknown, digest: string) => T) {
  const before = await image(ref.path, 16384)
  check(before.raw.length === ref.bytes && before.digest === ref.sha256, "Prepared Memory metadata changed")
  return metadata(ref.path, (value, digest) => {
    check(digest === ref.sha256, "Prepared Memory metadata changed during import")
    return decode(value, digest)
  })
}

/** Prepared metadata is a selection, never service trust, source approval or capture consent. */
export async function inspect(input: unknown) {
  const cfg = bundle(input)
  const selected = cfg.fresh
    ? await pinned(cfg.fresh, (input) => {
        check(input && typeof input === "object" && !Array.isArray(input), "Prepared fresh Memory selection required")
        const row = input as Record<string, unknown>
        check(
          [
            "raya.memory.closed-generation.fresh-start",
            "raya.memory.failed-search.fresh-start",
            "raya.memory.unclosed-pair.fresh-start",
            "raya.memory.interrupted-startup.fresh-start",
            "raya.memory.completed-handoff.fresh-start",
          ].includes(String(row.format)) && row.version === 1,
          "Reviewed fresh Memory selection required",
        )
        return { setup: parse(row.setup), managed: descriptor(row.managed) }
      })
    : { setup: await pinned(cfg.setup!, parse), managed: await pinned(cfg.managed!, descriptor) }
  check(selected.setup.version === 2 && selected.managed.version === 2, "Reviewed paired Memory runtime required")
  await selection(selected.managed, selected.setup)
  const catalog = await pinned(cfg.control, parseCatalog)
  check(
    catalog.version === selected.setup.version &&
      Object.entries(selected.setup.source_sha256).every(([name, hash]) => catalog.source_sha256[name] === hash),
    "Prepared control and search releases differ",
  )
  return { bundle: cfg, ...selected, catalog }
}

export type PreparedSetup = Awaited<ReturnType<typeof inspect>>
