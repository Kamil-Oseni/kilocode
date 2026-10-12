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
  "proposals.py",
] as const

export function pins(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Memory source pins are required")
  const rows = input as Record<string, unknown>
  const names =
    "entries.py" in rows || "management.py" in rows
      ? [...sources, "capture.py", "entries.py", "management.py"]
      : "capture.py" in rows
        ? [...sources, "capture.py"]
        : sources
  if (
    Object.keys(rows).sort().join() !== [...names].sort().join() ||
    names.some(
      (name) =>
        typeof rows[name] !== "string" ||
        (rows[name] as string).length !== 64 ||
        !/^[a-f0-9]{64}$/.test(rows[name] as string),
    )
  )
    throw new Error("Memory requires the exact reviewed source pins")
  return Object.freeze(Object.fromEntries(names.map((name) => [name, rows[name] as string])))
}

export function setup(value: Record<string, unknown>, url: string) {
  if (
    (value.protocol !== "raya.memory.operation.v1" && value.protocol !== "raya.memory.operation.v2") ||
    typeof value.root !== "string" ||
    !/^[a-z]:[/\\]/i.test(value.root) ||
    /[\x00-\x1f]/.test(value.root) ||
    value.root.length > 4096
  )
    throw new Error("Memory requires a bounded absolute Windows root")
  const selected = pins(value.source_sha256)
  return Object.freeze({
    format: "raya.memory.setup" as const,
    version: 2 as const,
    protocol: value.protocol,
    origin: url,
    root: value.root,
    source_sha256: selected,
  })
}
