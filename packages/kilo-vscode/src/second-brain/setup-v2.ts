/** Schema foundation only; operational v2 activation requires the client lifetime adapter. */
export const sources = [
  "server.py",
  "index.py",
  "notes.py",
  "policy.py",
  "admission.py",
  "host.py",
  "operations.py",
  "retirement.py",
  "namespace.py",
  "historical.py",
  "dispatch.py",
] as const

export function setup(value: Record<string, unknown>, url: string) {
  if (
    value.protocol !== "raya.memory.operation.v1" ||
    typeof value.root !== "string" ||
    !/^[a-z]:[/\\]/i.test(value.root) ||
    /[\x00-\x1f]/.test(value.root) ||
    value.root.length > 4096
  )
    throw new Error("Memory requires a bounded absolute Windows root")
  const pins = value.source_sha256
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw new Error("Memory source pins are required")
  const rows = pins as Record<string, unknown>
  if (
    Object.keys(rows).sort().join() !== [...sources].sort().join() ||
    sources.some(
      (name) =>
        typeof rows[name] !== "string" ||
        (rows[name] as string).length !== 64 ||
        !/^[a-f0-9]{64}$/.test(rows[name] as string),
    )
  )
    throw new Error("Memory requires exactly eleven reviewed source pins")
  return Object.freeze({
    format: "raya.memory.setup" as const,
    version: 2 as const,
    protocol: "raya.memory.operation.v1" as const,
    origin: url,
    root: value.root,
    source_sha256: Object.freeze(Object.fromEntries(sources.map((name) => [name, rows[name] as string]))),
  })
}
