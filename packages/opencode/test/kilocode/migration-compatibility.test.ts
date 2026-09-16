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
