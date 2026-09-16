import { Config } from "effect"
import { InstallationChannel } from "../installation/version" // kilocode_change
import { EnvAlias } from "../kilocode/env-alias" // kilocode_change

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

// kilocode_change start
function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

const UNSTABLE_CHANNELS = new Set(["dev", "beta", "local"])
function unstableDefault(key: string) {
  return truthy(key) || (!falsy(key) && UNSTABLE_CHANNELS.has(InstallationChannel))
}

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const KILO_EXPERIMENTAL = truthy("KILO_EXPERIMENTAL")
const KILO_DISABLE_CLAUDE_CODE = truthy("KILO_DISABLE_CLAUDE_CODE")
const KILO_DISABLE_CLAUDE_CODE_SKILLS = KILO_DISABLE_CLAUDE_CODE || truthy("KILO_DISABLE_CLAUDE_CODE_SKILLS")
// kilocode_change end
const copy = process.env["KILO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["KILO_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("KILO_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  KILO_AUTO_SHARE: truthy("KILO_AUTO_SHARE"), // kilocode_change
  KILO_AUTO_HEAP_SNAPSHOT: truthy("KILO_AUTO_HEAP_SNAPSHOT"),
  // kilocode_change start - Raya input alias with mutable compatibility access
  get KILO_GIT_BASH_PATH() {
    return EnvAlias.read("RAYA_GIT_BASH_PATH", "KILO_GIT_BASH_PATH")
  },
  set KILO_GIT_BASH_PATH(value: string | undefined) {
    EnvAlias.write("RAYA_GIT_BASH_PATH", "KILO_GIT_BASH_PATH", value)
  },
  // kilocode_change end
  // kilocode_change start - Raya input aliases preserve Kilo compatibility names and runtime reads for callers
  get KILO_CONFIG() {
    return EnvAlias.read("RAYA_CONFIG", "KILO_CONFIG")
  },
  set KILO_CONFIG(value: string | undefined) {
    EnvAlias.write("RAYA_CONFIG", "KILO_CONFIG", value)
  },
  get KILO_CONFIG_CONTENT() {
    return EnvAlias.read("RAYA_CONFIG_CONTENT", "KILO_CONFIG_CONTENT")
  },
  set KILO_CONFIG_CONTENT(value: string | undefined) {
    EnvAlias.write("RAYA_CONFIG_CONTENT", "KILO_CONFIG_CONTENT", value)
  },
  // kilocode_change end
  KILO_DISABLE_AUTOUPDATE: truthy("KILO_DISABLE_AUTOUPDATE"),
  KILO_ALWAYS_NOTIFY_UPDATE: truthy("KILO_ALWAYS_NOTIFY_UPDATE"),
  KILO_DISABLE_PRUNE: truthy("KILO_DISABLE_PRUNE"),
  KILO_DISABLE_TERMINAL_TITLE: truthy("KILO_DISABLE_TERMINAL_TITLE"),
  KILO_SHOW_TTFD: truthy("KILO_SHOW_TTFD"),
  // kilocode_change start
  KILO_DISABLE_DEFAULT_PLUGINS: truthy("KILO_DISABLE_DEFAULT_PLUGINS"),
  KILO_DISABLE_LSP_DOWNLOAD: truthy("KILO_DISABLE_LSP_DOWNLOAD"),
  KILO_ENABLE_EXPERIMENTAL_MODELS: truthy("KILO_ENABLE_EXPERIMENTAL_MODELS"),
  // kilocode_change end
  KILO_DISABLE_AUTOCOMPACT: truthy("KILO_DISABLE_AUTOCOMPACT"),
  KILO_DISABLE_MODELS_FETCH: truthy("KILO_DISABLE_MODELS_FETCH"),
  KILO_DISABLE_MOUSE: truthy("KILO_DISABLE_MOUSE"),
  // kilocode_change start
  KILO_DISABLE_CLAUDE_CODE,
  KILO_DISABLE_CLAUDE_CODE_PROMPT: KILO_DISABLE_CLAUDE_CODE || truthy("KILO_DISABLE_CLAUDE_CODE_PROMPT"),
  KILO_DISABLE_CLAUDE_CODE_SKILLS,
  KILO_DISABLE_EXTERNAL_SKILLS: truthy("KILO_DISABLE_EXTERNAL_SKILLS"),
  KILO_EXPERIMENTAL_CUSTOMIZE_SKILL: unstableDefault("KILO_EXPERIMENTAL_CUSTOMIZE_SKILL"),
  // kilocode_change end
  KILO_FAKE_VCS: process.env["KILO_FAKE_VCS"],
  // kilocode_change start - credential aliases fail closed instead of selecting a conflicting secret
  get KILO_SERVER_PASSWORD() {
    return EnvAlias.credential(undefined, "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD")
  },
  set KILO_SERVER_PASSWORD(value: string | undefined) {
    EnvAlias.write("RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", value)
  },
  get KILO_SERVER_USERNAME() {
    return EnvAlias.credential(undefined, "RAYA_SERVER_USERNAME", "KILO_SERVER_USERNAME")
  },
  set KILO_SERVER_USERNAME(value: string | undefined) {
    EnvAlias.write("RAYA_SERVER_USERNAME", "KILO_SERVER_USERNAME", value)
  },
  // kilocode_change end
  KILO_ENABLE_QUESTION_TOOL: truthy("KILO_ENABLE_QUESTION_TOOL"), // kilocode_change

  KILO_EXPERIMENTAL, // kilocode_change

  KILO_EXPERIMENTAL_FILEWATCHER: Config.boolean("KILO_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)), // kilocode_change

  KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("KILO_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),

  KILO_EXPERIMENTAL_ICON_DISCOVERY: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_ICON_DISCOVERY"), // kilocode_change

  KILO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("KILO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),

  KILO_ENABLE_EXA: truthy("KILO_ENABLE_EXA") || KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_EXA"), // kilocode_change

  KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"), // kilocode_change

  KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX"), // kilocode_change

  KILO_EXPERIMENTAL_OXFMT: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_OXFMT"), // kilocode_change

  KILO_EXPERIMENTAL_LSP_TY: truthy("KILO_EXPERIMENTAL_LSP_TY"), // kilocode_change

  KILO_EXPERIMENTAL_LSP_TOOL: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_LSP_TOOL"), // kilocode_change

  KILO_EXPERIMENTAL_PLAN_MODE: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_PLAN_MODE"), // kilocode_change

  KILO_EXPERIMENTAL_SCOUT: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_SCOUT"), // kilocode_change

  KILO_EXPERIMENTAL_MARKDOWN: !falsy("KILO_EXPERIMENTAL_MARKDOWN"), // kilocode_change

  KILO_ENABLE_PARALLEL: truthy("KILO_ENABLE_PARALLEL") || truthy("KILO_EXPERIMENTAL_PARALLEL"), // kilocode_change

  // kilocode_change start - Raya input alias with mutable compatibility access
  get KILO_MODELS_URL() {
    return EnvAlias.read("RAYA_MODELS_URL", "KILO_MODELS_URL")
  },
  set KILO_MODELS_URL(value: string | undefined) {
    EnvAlias.write("RAYA_MODELS_URL", "KILO_MODELS_URL", value)
  },
  // kilocode_change end

  // kilocode_change start - Raya input alias with mutable compatibility access
  get KILO_MODELS_PATH() {
    return EnvAlias.read("RAYA_MODELS_PATH", "KILO_MODELS_PATH")
  },
  set KILO_MODELS_PATH(value: string | undefined) {
    EnvAlias.write("RAYA_MODELS_PATH", "KILO_MODELS_PATH", value)
  },
  // kilocode_change end

  KILO_DISABLE_EMBEDDED_WEB_UI: truthy("KILO_DISABLE_EMBEDDED_WEB_UI"), // kilocode_change

  // kilocode_change start - Raya input alias with mutable compatibility access
  get KILO_DB() {
    return EnvAlias.read("RAYA_DB", "KILO_DB")
  },
  set KILO_DB(value: string | undefined) {
    EnvAlias.write("RAYA_DB", "KILO_DB", value)
  },
  // kilocode_change end

  KILO_DISABLE_CHANNEL_DB: truthy("KILO_DISABLE_CHANNEL_DB"), // kilocode_change

  KILO_SKIP_MIGRATIONS: truthy("KILO_SKIP_MIGRATIONS"), // kilocode_change

  KILO_STRICT_CONFIG_DEPS: truthy("KILO_STRICT_CONFIG_DEPS"), // kilocode_change

  KILO_WORKSPACE_ID: process.env["KILO_WORKSPACE_ID"],

  KILO_EXPERIMENTAL_WORKSPACES: enabledByExperimental("KILO_EXPERIMENTAL_WORKSPACES"),

  KILO_EXPERIMENTAL_EVENT_SYSTEM: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_EVENT_SYSTEM"), // kilocode_change

  KILO_EXPERIMENTAL_SESSION_SWITCHING: KILO_EXPERIMENTAL || truthy("KILO_EXPERIMENTAL_SESSION_SWITCHING"), // kilocode_change

  KILO_EXPERIMENTAL_SESSION_SWITCHER: enabledByExperimental("KILO_EXPERIMENTAL_SESSION_SWITCHER"), // kilocode_change

  KILO_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("KILO_DISABLE_FFF"), // kilocode_change

  // kilocode_change start - Raya input alias retains the Kilo compatibility name
  get KILO_DISABLE_PROJECT_CONFIG() {
    const value = EnvAlias.read("RAYA_DISABLE_PROJECT_CONFIG", "KILO_DISABLE_PROJECT_CONFIG")?.toLowerCase()
    return value === "true" || value === "1"
  },
  set KILO_DISABLE_PROJECT_CONFIG(value: boolean) {
    EnvAlias.write("RAYA_DISABLE_PROJECT_CONFIG", "KILO_DISABLE_PROJECT_CONFIG", value ? "1" : "0")
  },
  // kilocode_change end
  get KILO_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("KILO_EXPERIMENTAL_REFERENCES")
  },
  // kilocode_change start - Raya input alias with mutable compatibility access
  get KILO_TUI_CONFIG() {
    return EnvAlias.read("RAYA_TUI_CONFIG", "KILO_TUI_CONFIG")
  },
  set KILO_TUI_CONFIG(value: string | undefined) {
    EnvAlias.write("RAYA_TUI_CONFIG", "KILO_TUI_CONFIG", value)
  },
  // kilocode_change end
  // kilocode_change start - Raya input alias with mutable compatibility access
  get KILO_CONFIG_DIR() {
    return EnvAlias.read("RAYA_CONFIG_DIR", "KILO_CONFIG_DIR")
  },
  set KILO_CONFIG_DIR(value: string | undefined) {
    EnvAlias.write("RAYA_CONFIG_DIR", "KILO_CONFIG_DIR", value)
  },
  // kilocode_change end
  // kilocode_change start - either compatibility name can enable safety-sensitive pure mode
  get KILO_PURE() {
    return EnvAlias.enabled("RAYA_PURE", "KILO_PURE")
  },
  // kilocode_change end
  get KILO_PERMISSION() {
    return process.env["KILO_PERMISSION"]
  },
  get KILO_PLUGIN_META_FILE() {
    return process.env["KILO_PLUGIN_META_FILE"]
  },
  get KILO_CLIENT() {
    return process.env["KILO_CLIENT"] ?? "cli"
  },
  // kilocode_change start
  get KILO_SESSION_RETRY_LIMIT() {
    const value = EnvAlias.read("RAYA_SESSION_RETRY_LIMIT", "KILO_SESSION_RETRY_LIMIT")
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  },
  // kilocode_change end
}
