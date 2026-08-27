import type { Config } from "../../types/messages"
import { deepMerge } from "../../utils/config-utils"
import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings } from "../../../../src/shared/speech"

/** Maximum import file size in bytes (1 MB). */
export const MAX_IMPORT_SIZE = 1_048_576

/** Current export format version. */
export const META_VERSION = 2 // raya_change - scoped config and speech preferences

/** Top-level keys recognised as valid Config fields. */
export const KNOWN_KEYS: ReadonlyArray<string> = [
  "permission",
  "model",
  "small_model",
  "raya_routing", // raya_change - keep Goals & routing import/export in sync with Config
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

export type SettingsScopes = {
  global: Config
  project: Config
}

export type SettingsExport = SettingsScopes & {
  speech?: SpeechSettings
}

export type ImportResult =
  | {
      ok: true
      config: Config
      scopes?: SettingsScopes
      speech?: Partial<SpeechSettings>
      warning?: ImportWarning
    }
  | { ok: false; error: ImportError }

interface ExportMeta {
  version: number
  exportedAt: string
  secretsStripped: true // raya_change - Milestone I exports are non-secret
}

// raya_change start - remove credentials defensively even when hand-written config contains them
const SECRET_KEYS = /^(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)$/i
const SECRET_HEADERS = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/i
const SECRET_QUERY = /^(?:key|api[_-]?key|access[_-]?token|token|secret|password|authorization)$/i
const SPEECH_KEYS = Object.keys(DEFAULT_SPEECH_SETTINGS) as Array<keyof SpeechSettings>

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function scrubUrl(value: string) {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value) || !URL.canParse(value)) return value
  const url = new URL(value)
  let changed = !!url.username || !!url.password
  url.username = ""
  url.password = ""
  for (const key of [...url.searchParams.keys()]) {
    if (!SECRET_QUERY.test(key)) continue
    changed = true
    url.searchParams.delete(key)
  }
  return changed ? url.toString() : value
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (typeof value === "string") return scrubUrl(value)
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

function config(value: unknown): Config {
  if (!record(value)) return {}
  const result: Record<string, unknown> = {}
  for (const key of KNOWN_KEYS) {
    if (key in value && value[key] !== undefined) result[key] = value[key]
  }
  return scrub(result) as Config
}

function speech(value: unknown): Partial<SpeechSettings> | undefined {
  if (!record(value)) return
  const result: Partial<SpeechSettings> = {}
  for (const key of SPEECH_KEYS) {
    const item = value[key]
    const fallback = DEFAULT_SPEECH_SETTINGS[key]
    if (typeof item !== typeof fallback) continue
    Object.assign(result, { [key]: scrub(item) })
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function scoped(value: Config | SettingsExport): value is SettingsExport {
  return "global" in value && "project" in value
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Build a JSON-serialisable export payload from the current config.
 * Non-secret fields are included so the export can reconstruct provider and
 * agent-model configuration without carrying credentials. // raya_change
 */
export function buildExport(cfg: Config | SettingsExport): Record<string, unknown> {
  const meta: ExportMeta = {
    version: META_VERSION,
    exportedAt: new Date().toISOString(),
    secretsStripped: true, // raya_change
  }

  const out: Record<string, unknown> = { _meta: meta }

  if (scoped(cfg)) {
    out.global = config(cfg.global)
    out.project = config(cfg.project)
    const settings = speech(cfg.speech)
    if (settings) out.speech = settings
    return out
  }

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

  // raya_change start - v2 preserves global/project ownership and non-secret speech preferences.
  if ("global" in obj || "project" in obj || "speech" in obj) {
    const scopes = {
      global: config(obj.global),
      project: config(obj.project),
    }
    const settings = speech(obj.speech)
    if (Object.keys(scopes.global).length === 0 && Object.keys(scopes.project).length === 0 && !settings) {
      return { ok: false, error: "invalidConfig" }
    }
    const result = {
      ok: true as const,
      config: deepMerge(scopes.global, scopes.project),
      scopes,
      ...(settings ? { speech: settings } : {}),
      ...(warning ? { warning } : {}),
    }
    return result
  }
  // raya_change end

  const safe = config(obj) // raya_change - imports cannot bypass secret-storage-only BYOK handling
  if (Object.keys(safe).length === 0) return { ok: false, error: "invalidConfig" }
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
