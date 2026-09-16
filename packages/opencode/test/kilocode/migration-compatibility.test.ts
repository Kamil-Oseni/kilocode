import { describe, expect, test } from "bun:test"
import { RayaMigrationLedger } from "@/kilocode/migration/compatibility"

describe("Raya migration compatibility ledger", () => {
  test("keeps every live identity behind explicit evidence", () => {
    const snapshot = RayaMigrationLedger.make()
    expect(snapshot.format).toBe("raya.compatibility-ledger")
    expect(snapshot.version).toBe(1)
    expect(snapshot.entries.map((item) => item.id).sort()).toEqual([
      "cli-command",
      "configuration-sources",
      "credential-storage",
      "database-files",
      "editor-distribution",
      "environment-inputs",
      "event-identities",
      "http-identities",
      "package-identities",
      "physical-executable",
      "profile-roots",
      "provider-identities",
      "telemetry-identities",
    ])
    expect(new Set(snapshot.entries.map((item) => item.id)).size).toBe(snapshot.entries.length)
    expect(snapshot.entries.every((item) => item.cutoverReady === false)).toBe(true)

    const command = snapshot.entries.find((item) => item.id === "cli-command")
    expect(command).toMatchObject({
      phase: "alias-active",
      evidence: ["additive-alias", "exact-verification"],
      cutoverReady: false,
    })
    expect(command?.identities).toContainEqual({
      kind: "manifest:bin",
      raya: "raya",
      legacy: "./bin/kilo",
      policy: "raya-preferred",
    })
    const environment = snapshot.entries.find((item) => item.id === "environment-inputs")
    expect(environment?.identities).toContainEqual({
      kind: "environment:db",
      raya: "RAYA_DB",
      legacy: "KILO_DB",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:bin_path",
      raya: "RAYA_BIN_PATH",
      legacy: "KILO_BIN_PATH",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:tui_config",
      raya: "RAYA_TUI_CONFIG",
      legacy: "KILO_TUI_CONFIG",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:models_url",
      raya: "RAYA_MODELS_URL",
      legacy: "KILO_MODELS_URL",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:command_timeout_max_ms",
      raya: "RAYA_COMMAND_TIMEOUT_MAX_MS",
      legacy: "KILO_COMMAND_TIMEOUT_MAX_MS",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:command_timeout_max_ms_message",
      raya: "RAYA_COMMAND_TIMEOUT_MAX_MS_MESSAGE",
      legacy: "KILO_COMMAND_TIMEOUT_MAX_MS_MESSAGE",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:no_daemon",
      raya: "RAYA_NO_DAEMON",
      legacy: "KILO_NO_DAEMON",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:log_level",
      raya: "RAYA_LOG_LEVEL",
      legacy: "KILO_LOG_LEVEL",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:print_logs",
      raya: "RAYA_PRINT_LOGS",
      legacy: "KILO_PRINT_LOGS",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:websearch_provider",
      raya: "RAYA_WEBSEARCH_PROVIDER",
      legacy: "KILO_WEBSEARCH_PROVIDER",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_project_config",
      raya: "RAYA_DISABLE_PROJECT_CONFIG",
      legacy: "KILO_DISABLE_PROJECT_CONFIG",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:session_retry_limit",
      raya: "RAYA_SESSION_RETRY_LIMIT",
      legacy: "KILO_SESSION_RETRY_LIMIT",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:show_ttfd",
      raya: "RAYA_SHOW_TTFD",
      legacy: "KILO_SHOW_TTFD",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_codebase_indexing",
      raya: "RAYA_DISABLE_CODEBASE_INDEXING",
      legacy: "KILO_DISABLE_CODEBASE_INDEXING",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:auto_heap_snapshot",
      raya: "RAYA_AUTO_HEAP_SNAPSHOT",
      legacy: "KILO_AUTO_HEAP_SNAPSHOT",
      policy: "raya-wins-legacy-write",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:permission",
      raya: "RAYA_PERMISSION",
      legacy: "KILO_PERMISSION",
      policy: "matching-authority-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:pure",
      raya: "RAYA_PURE",
      legacy: "KILO_PURE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_mouse",
      raya: "RAYA_DISABLE_MOUSE",
      legacy: "KILO_DISABLE_MOUSE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_autocompact",
      raya: "RAYA_DISABLE_AUTOCOMPACT",
      legacy: "KILO_DISABLE_AUTOCOMPACT",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_prune",
      raya: "RAYA_DISABLE_PRUNE",
      legacy: "KILO_DISABLE_PRUNE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_default_plugins",
      raya: "RAYA_DISABLE_DEFAULT_PLUGINS",
      legacy: "KILO_DISABLE_DEFAULT_PLUGINS",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_lsp_download",
      raya: "RAYA_DISABLE_LSP_DOWNLOAD",
      legacy: "KILO_DISABLE_LSP_DOWNLOAD",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_autoupdate",
      raya: "RAYA_DISABLE_AUTOUPDATE",
      legacy: "KILO_DISABLE_AUTOUPDATE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:always_notify_update",
      raya: "RAYA_ALWAYS_NOTIFY_UPDATE",
      legacy: "KILO_ALWAYS_NOTIFY_UPDATE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_models_fetch",
      raya: "RAYA_DISABLE_MODELS_FETCH",
      legacy: "KILO_DISABLE_MODELS_FETCH",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_terminal_title",
      raya: "RAYA_DISABLE_TERMINAL_TITLE",
      legacy: "KILO_DISABLE_TERMINAL_TITLE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_embedded_web_ui",
      raya: "RAYA_DISABLE_EMBEDDED_WEB_UI",
      legacy: "KILO_DISABLE_EMBEDDED_WEB_UI",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_external_skills",
      raya: "RAYA_DISABLE_EXTERNAL_SKILLS",
      legacy: "KILO_DISABLE_EXTERNAL_SKILLS",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_claude_code",
      raya: "RAYA_DISABLE_CLAUDE_CODE",
      legacy: "KILO_DISABLE_CLAUDE_CODE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_claude_code_prompt",
      raya: "RAYA_DISABLE_CLAUDE_CODE_PROMPT",
      legacy: "KILO_DISABLE_CLAUDE_CODE_PROMPT",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_claude_code_skills",
      raya: "RAYA_DISABLE_CLAUDE_CODE_SKILLS",
      legacy: "KILO_DISABLE_CLAUDE_CODE_SKILLS",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_skill_shell",
      raya: "RAYA_DISABLE_SKILL_SHELL",
      legacy: "KILO_DISABLE_SKILL_SHELL",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_channel_db",
      raya: "RAYA_DISABLE_CHANNEL_DB",
      legacy: "KILO_DISABLE_CHANNEL_DB",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:skip_migrations",
      raya: "RAYA_SKIP_MIGRATIONS",
      legacy: "KILO_SKIP_MIGRATIONS",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_share",
      raya: "RAYA_DISABLE_SHARE",
      legacy: "KILO_DISABLE_SHARE",
      policy: "safety-monotonic-aliases",
    })
    expect(environment?.identities).toContainEqual({
      kind: "environment:disable_presence",
      raya: "RAYA_DISABLE_PRESENCE",
      legacy: "KILO_DISABLE_PRESENCE",
      policy: "safety-monotonic-aliases",
    })
    const database = snapshot.entries.find((item) => item.id === "database-files")
    expect(database?.identities.map((item) => item.legacy)).toEqual([
      "kilo.db",
      "kilo-${InstallationChannel}.db",
      "opencode-${InstallationChannel}.db",
    ])
    const editor = snapshot.entries.find((item) => item.id === "editor-distribution")
    expect(editor?.phase).toBe("deferred-version-3")
  })

  test("refuses duplicate identities and evidence outside the gate", () => {
    const base = RayaMigrationLedger.snapshot.entries[0]
    if (!base) throw new Error("Expected the migration ledger to contain a command entry.")
    const item = {
      id: base.id,
      area: base.area,
      phase: base.phase,
      identities: base.identities,
      required: base.required,
      evidence: base.evidence,
    }
    expect(() => RayaMigrationLedger.make([item, item])).toThrow("Duplicate migration ledger id")
    expect(() => RayaMigrationLedger.make([{ ...item, id: "invalid", evidence: ["dual-write"] }])).toThrow(
      "Migration ledger evidence is not required",
    )
  })

  test("contains identifiers only and no machine paths", () => {
    const text = JSON.stringify(RayaMigrationLedger.snapshot)
    expect(text).not.toContain("C:\\")
    expect(text).not.toContain("/Users/")
    expect(text).not.toContain("/home/")
    expect(text).not.toContain("Bearer ")
  })
})
