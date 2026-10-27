import { z } from "zod"

const Origin = z.enum(["global", "project", "system", "default", "unknown"])
const Status = z.enum(["connected", "disabled", "failed", "needs_auth", "needs_client_registration", "unknown"])
const Descriptor = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(1024),
    name: z.string().min(1).max(1024),
    kind: z.literal("mcp"),
    transport: z.enum(["local", "remote", "unknown"]),
    origin: Origin,
    enabled: z.boolean(),
    status: Status,
    editable: z.boolean(),
    removable: z.boolean(),
    account: z.literal("unverified"),
    authority: z.literal("separate"),
    health: z.literal("last-received"),
  })
  .strict()
const Inventory = z
  .object({ version: z.literal(1), items: z.array(Descriptor).max(200), omitted: z.number().int().min(0) })
  .strict()
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Pure overview of existing snapshots. Never discovers or connects a server. */
export function inventory(input: { mcp?: unknown; collections?: unknown; status?: unknown }) {
  const servers = object(input.mcp) ? input.mcp : {}
  const collections = object(input.collections) ? input.collections.mcp : undefined
  const sources = Array.isArray(collections) ? collections : []
  const status = object(input.status) ? input.status : {}
  const names = Object.keys(servers).sort()
  const items = names.slice(0, 200).flatMap((name) => {
    const cfg = servers[name]
    if (!name || name.length > 1024 || !object(cfg)) return []
    const rows = sources.filter((row: unknown) => object(row) && row.key === name)
    const source: unknown = rows.length === 1 && object(rows[0]) ? rows[0].source : undefined
    const parsed = Origin.safeParse(source)
    const origin = parsed.success ? parsed.data : "unknown"
    const current = status[name]
    const observed = Status.safeParse(object(current) ? current.status : undefined)
    const editable = origin === "global" || origin === "project"
    return [
      Descriptor.parse({
        version: 1,
        id: name,
        name,
        kind: "mcp",
        transport:
          cfg.type === "local" || cfg.type === "remote"
            ? cfg.type
            : cfg.url
              ? "remote"
              : typeof cfg.command === "string" || Array.isArray(cfg.command)
                ? "local"
                : "unknown",
        origin,
        enabled: cfg.enabled !== false,
        status: observed.success ? observed.data : "unknown",
        editable,
        removable: editable,
        account: "unverified",
        authority: "separate",
        health: "last-received",
      }),
    ]
  })
  return Inventory.parse({ version: 1, items, omitted: names.length - items.length })
}
