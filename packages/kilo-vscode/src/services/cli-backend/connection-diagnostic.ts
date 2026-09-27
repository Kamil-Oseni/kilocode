type Phase = "capabilities" | "initial-sse" | "startup"

/** Keep connection diagnostics useful without serializing errors, URLs, or credentials. */
export function connectionDiagnostic(phase: Phase, port: number | undefined, error: unknown) {
  const result: { phase: Phase; port?: number; code?: string; address?: string; status?: number } = { phase }
  if (port && Number.isInteger(port) && port > 0 && port <= 65535) result.port = port
  const pending: unknown[] = [error]
  for (const _ of [0, 1, 2, 3]) {
    const value = pending.shift()
    if (!value || typeof value !== "object") continue
    const item = value as Record<string, unknown>
    if (!result.code && typeof item.code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(item.code))
      result.code = item.code
    if (!result.address && (item.address === "127.0.0.1" || item.address === "::1")) result.address = item.address
    if (
      !result.status &&
      typeof item.status === "number" &&
      Number.isInteger(item.status) &&
      item.status >= 100 &&
      item.status <= 599
    )
      result.status = item.status
    if (item.cause) pending.push(item.cause)
    if (Array.isArray(item.errors) && item.errors.length) pending.push(item.errors[0])
  }
  return result
}
