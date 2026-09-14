import { z } from "zod"

const absolute = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|\/)/

export const RoutinePaths = z
  .object({
    version: z.literal(1),
    grants: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(4096).regex(absolute),
            access: z.enum(["read", "write"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()

export type RoutinePaths = z.infer<typeof RoutinePaths>

function clean(path: string) {
  const value = path.trim().replaceAll("\\", "/")
  if (value === "/" || /^[a-zA-Z]:\/$/.test(value)) return value
  return value.replace(/\/+$/, "")
}

function key(path: string) {
  return /^(?:[a-zA-Z]:\/|\/\/)/.test(path) ? path.toLowerCase() : path
}

function inside(parent: string, child: string) {
  const root = key(parent)
  const path = key(child)
  return path === root || path.startsWith(root.endsWith("/") ? root : root + "/")
}

export function normalizeRoutinePaths(value: RoutinePaths): RoutinePaths {
  const unique = new Map<string, RoutinePaths["grants"][number]>()
  for (const item of value.grants) {
    const path = clean(item.path)
    const prior = unique.get(key(path))
    unique.set(key(path), { path, access: prior?.access === "write" ? "write" : item.access })
  }
  const grants: RoutinePaths["grants"] = []
  for (const item of [...unique.values()].sort(
    (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path),
  )) {
    const parent = grants.find((grant) => inside(grant.path, item.path))
    if (parent?.access === "write" || parent?.access === item.access) continue
    grants.push(item)
  }
  return { version: 1, grants }
}
