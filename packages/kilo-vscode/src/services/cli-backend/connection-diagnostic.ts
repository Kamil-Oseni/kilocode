type Phase = "capabilities" | "initial-sse" | "sdk-request" | "startup"

function code(value: unknown) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(value) ? value : undefined
}

function address(value: unknown) {
  return value === "127.0.0.1" || value === "::1" ? value : undefined
}

function status(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

/** Keep connection diagnostics useful without serializing errors, URLs, or credentials. */
export function connectionDiagnostic(phase: Phase, port: number | undefined, error: unknown) {
  const result: { phase: Phase; port?: number; code?: string; address?: string; status?: number } = { phase }
  if (port && Number.isInteger(port) && port > 0 && port <= 65535) result.port = port
  const pending: unknown[] = [error]
  for (const _ of [0, 1, 2, 3]) {
    const value = pending.shift()
    if (!value || typeof value !== "object") continue
    const item = value as Record<string, unknown>
    result.code ??= code(item.code)
    result.address ??= address(item.address)
    result.status ??= status(item.status)
    if (item.cause) pending.push(item.cause)
    if (Array.isArray(item.errors) && item.errors.length) pending.push(item.errors[0])
  }
  return result
}
