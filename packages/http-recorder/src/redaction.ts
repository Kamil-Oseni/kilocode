import { Schema } from "effect"

export const REDACTED = "[REDACTED]"

const DEFAULT_REDACT_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-amz-security-token",
  "x-goog-api-key",
]

const DEFAULT_REDACT_QUERY = [
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "code",
  "key",
  "signature",
  "sig",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
]

const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

const ENV_SECRET_NAMES = /(?:API|AUTH|BEARER|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i
const SAFE_ENV_VALUES = new Set(["fixture", "test", "test-key"])

const envSecrets = () =>
  Object.entries(process.env).flatMap(([name, value]) => {
    if (!value) return []
    if (!ENV_SECRET_NAMES.test(name)) return []
    if (value.length < 12) return []
    if (SAFE_ENV_VALUES.has(value.toLowerCase())) return []
    return [{ name, value }]
  })

const pathFor = (base: string, key: string) => (base ? `${base}.${key}` : key)

const stringEntries = (value: unknown, base = ""): ReadonlyArray<{ readonly path: string; readonly value: string }> => {
  if (typeof value === "string") return [{ path: base, value }]
  if (Array.isArray(value)) return value.flatMap((item, index) => stringEntries(item, `${base}[${index}]`))
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => stringEntries(child, pathFor(base, key)))
  }
  return []
}

const redactionSet = (values: ReadonlyArray<string> | undefined, defaults: ReadonlyArray<string>) =>
  new Set([...defaults, ...(values ?? [])].map((value) => value.toLowerCase()))

export type UrlRedactor = (url: string) => string

export const redactUrl = (
  raw: string,
  query: ReadonlyArray<string> = DEFAULT_REDACT_QUERY,
  urlRedactor?: UrlRedactor,
) => {
  if (!URL.canParse(raw)) return urlRedactor?.(raw) ?? raw
  const url = new URL(raw)
  if (url.username) url.username = REDACTED
  if (url.password) url.password = REDACTED
  const redacted = redactionSet(query, DEFAULT_REDACT_QUERY)
  for (const key of url.searchParams.keys()) {
    if (redacted.has(key.toLowerCase())) url.searchParams.set(key, REDACTED)
  }
  return urlRedactor?.(url.toString()) ?? url.toString()
}

export const redactHeaders = (
  headers: Record<string, string>,
  allow: ReadonlyArray<string>,
  redact: ReadonlyArray<string> = DEFAULT_REDACT_HEADERS,
) => {
  const allowed = new Set(allow.map((name) => name.toLowerCase()))
  const redacted = redactionSet(redact, DEFAULT_REDACT_HEADERS)
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => allowed.has(name))
      .map(([name, value]) => [name, redacted.has(name) ? REDACTED : value] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  )
}

export const SecretFindingSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
})
export type SecretFinding = Schema.Schema.Type<typeof SecretFindingSchema>

// kilocode_change start - scan declared binary bodies without changing replay bytes
const binary = (value: unknown): { entries: { path: string; value: string }[]; findings: SecretFinding[] } => {
  const entries: { path: string; value: string }[] = []
  const findings: SecretFinding[] = []
  let budget = 8 * 1024 * 1024
  const decode = (value: unknown, path: string) => {
    if (typeof value !== "string" || value.length % 4 !== 0) {
      findings.push({ path, reason: "invalid declared base64 body" })
      return
    }
    const size = (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
    if (size > budget) {
      findings.push({ path, reason: "binary inspection exceeds 8 MiB budget" })
      return
    }
    budget -= size
    const bytes = Buffer.from(value, "base64")
    if (bytes.toString("base64") !== value) {
      findings.push({ path, reason: "invalid declared base64 body" })
      return
    }
    entries.push({ path, value: bytes.toString("utf8") })
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (!object(value)) return
    const record = value
    if (record.transport === "http" && object(record.response)) {
      const response = record.response
      if (response.bodyEncoding === "base64") decode(response.body, pathFor(path, "response.body"))
    }
    if (record.transport === "websocket" && Array.isArray(record.events)) {
      record.events.forEach((event: unknown, index) => {
        if (!object(event) || event.kind !== "binary") return
        const location = `${pathFor(path, "events")}[${index}].body`
        if (event.bodyEncoding !== "base64") {
          findings.push({ path: location, reason: "invalid declared binary encoding" })
          return
        }
        decode(event.body, location)
      })
    }
    for (const [key, child] of Object.entries(record)) walk(child, pathFor(path, key))
  }
  walk(value, "")
  return { entries, findings }
}
// kilocode_change end

export const secretFindings = (value: unknown): ReadonlyArray<SecretFinding> => {
  const environment = envSecrets()
  const decoded = binary(value) // kilocode_change
  // kilocode_change - include declared binary projections in the existing detector
  const findings = [...stringEntries(value), ...decoded.entries].flatMap((entry) => [
    ...SECRET_PATTERNS.filter((item) => item.pattern.test(entry.value)).map((item) => ({
      path: entry.path,
      reason: item.label,
    })),
    ...environment
      .filter((item) => entry.value.includes(item.value))
      .map((item) => ({ path: entry.path, reason: `environment secret ${item.name}` })),
  ])
  return decoded.findings.concat(findings) // kilocode_change
}
