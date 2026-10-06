import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { Memento } from "vscode"
import type { BrainSettings } from "./settings"
import { parseCatalog } from "./control/catalog"

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

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

/** Configuration evidence only: no service intake, approval, credential disclosure or persistence. */
export async function diagnostic(settings: BrainSettings, storage: Pick<Memento, "get">) {
  const denied = { scope: "configuration-only", runtimeAccepted: false, status: "unconfirmed" } as const
  try {
    const before = structuredClone(storage.get<unknown>("raya.secondBrain.setup"))
    const selected = structuredClone(storage.get<unknown>("raya.secondBrain.control.catalog"))
    const cfg = await settings.load()
    if (!cfg)
      return before === undefined &&
        storage.get<unknown>("raya.secondBrain.setup") === undefined &&
        isDeepStrictEqual(selected, storage.get<unknown>("raya.secondBrain.control.catalog"))
        ? { ...denied, status: "unconfigured" as const }
        : denied
    const catalog = selected as { root?: unknown; catalog?: unknown } | undefined
    const parsed = catalog === undefined ? undefined : parseCatalog(catalog.catalog)
    if (
      catalog &&
      (!parsed ||
        catalog.root !== cfg.setup.root ||
        parsed.version !== cfg.setup.version ||
        !isDeepStrictEqual(parsed.source_sha256, cfg.setup.source_sha256))
    )
      return denied
    const after = await settings.load()
    if (
      !after ||
      !isDeepStrictEqual(cfg, after) ||
      !isDeepStrictEqual(before, storage.get<unknown>("raya.secondBrain.setup")) ||
      !isDeepStrictEqual(selected, storage.get<unknown>("raya.secondBrain.control.catalog")) ||
      settings.pending() !== undefined
    )
      return denied
    return {
      ...denied,
      status: "configured" as const,
      version: cfg.setup.version,
      credentialPresent: true,
      managed: cfg.managed !== undefined,
      setupSHA256: digest(cfg.setup),
      descriptorSHA256: cfg.managed ? digest(cfg.managed) : undefined,
      controlSelected: parsed !== undefined,
      catalogSHA256: parsed ? digest(parsed) : undefined,
    }
  } catch {
    // A failed read or validation is unconfirmed; never expose paths or secret-bearing errors.
    return denied
  }
}
