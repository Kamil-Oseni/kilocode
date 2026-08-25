import type { Config } from "../../types/messages"
import { deepMerge } from "../../utils/config-utils"

/** Maximum import file size in bytes (1 MB). */
export const MAX_IMPORT_SIZE = 1_048_576

/** Current export format version. */
export const META_VERSION = 1

/** Top-level keys recognised as valid Config fields. */
export const KNOWN_KEYS: ReadonlyArray<string> = [
  "permission",
  "model",
  "small_model",
  "subagent_model",
  "subagent_variant",
  "subagent_variant_overrides",
  "default_agent",
  "agent",
  "provider",
  "disabled_providers",
  "enabled_providers",
  "mcp",
  "command",
  "instructions",
  "skills",
  "snapshot",
  "remote_control",
  "share",
  "username",
  "watcher",
  "formatter",
  "lsp",
  "compaction",
  "commit_message",
  "tools",
  "web_search",
  "auto_collapse_reasoning",
  "terminal_command_display",
  "code_edit_display",
  "mcp_tool_display",
  "hide_prompt_training_models",
  "sandbox",
  "indexing",
  "experimental",
]

export type ImportError = "invalidJson" | "invalidConfig" | "tooLarge"
export type ImportWarning = "newerVersion"

export type ImportResult = { ok: true; config: Config; warning?: ImportWarning } | { ok: false; error: ImportError }

interface ExportMeta {
  version: number
  exportedAt: string
  secretsStripped: true // raya_change - Milestone I exports are non-secret
}

// raya_change start - remove credentials defensively even when hand-written config contains them
const SECRET_KEYS = /^(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)$/i
const SECRET_HEADERS = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/i

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (!record(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) continue
    if ((key === "env" || key === "environment") && record(item)) continue
    if (key === "headers" && record(item)) {
      result[key] = Object.fromEntries(
        Object.entries(item)
          .filter(([name]) => !SECRET_HEADERS.test(name))
          .map(([name, header]) => [name, scrub(header)]),
      )
      continue
    }
    result[key] = scrub(item)
  }
  return result
}
// raya_change end

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Build a JSON-serialisable export payload from the current config.
 * Non-secret fields are included so the export can reconstruct provider and
 * agent-model configuration without carrying credentials. // raya_change
 */
export function buildExport(cfg: Config): Record<string, unknown> {
  const meta: ExportMeta = {
    version: META_VERSION,
    exportedAt: new Date().toISOString(),
    secretsStripped: true, // raya_change
  }

  const out: Record<string, unknown> = { _meta: meta }

  const safe = scrub(cfg) as Record<string, unknown> // raya_change - never export provider or embedded credentials
  for (const [key, value] of Object.entries(safe)) {
    if (value === undefined || value === null) continue
    out[key] = value
  }

  return out
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a validated Config.
 * Unknown keys and `_meta` are stripped. Returns an error tag on failure
 * or a warning when the file was exported from a newer version.
 */
export function parseImport(json: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { ok: false, error: "invalidJson" }
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "invalidJson" }
  }

  const obj = data as Record<string, unknown>

  // Check for newer version warning
  let warning: ImportWarning | undefined
  const meta = obj._meta
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    const version = (meta as Record<string, unknown>).version
    if (typeof version === "number" && version > META_VERSION) {
      warning = "newerVersion"
    }
  }

  // Keep only known config keys
  const config: Record<string, unknown> = {}
  for (const key of KNOWN_KEYS) {
    if (key in obj && obj[key] !== undefined) {
      config[key] = obj[key]
    }
  }

  // Must have at least one known key
  if (Object.keys(config).length === 0) {
    return { ok: false, error: "invalidConfig" }
  }

  const safe = scrub(config) as Config // raya_change - imports cannot bypass secret-storage-only BYOK handling
  return warning ? { ok: true, config: safe, warning } : { ok: true, config: safe }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Deep-merge imported config on top of existing config.
 * Imported values take precedence; existing values not in import are preserved.
 */
export function mergeConfig(existing: Config, imported: Config): Config {
  return deepMerge(existing, imported)
}
