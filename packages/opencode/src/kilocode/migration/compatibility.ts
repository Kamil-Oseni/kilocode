import { Schema } from "effect"

export namespace RayaMigrationLedger {
  export const Phase = Schema.Literals(["alias-active", "legacy-canonical", "deferred-version-3"])
  export type Phase = typeof Phase.Type

  export const Area = Schema.Literals([
    "command",
    "environment",
    "configuration",
    "executable",
    "package",
    "provider",
    "protocol",
    "event",
    "storage",
    "database",
    "credential",
    "telemetry",
    "editor",
  ])
  export type Area = typeof Area.Type

  export const Proof = Schema.Literals([
    "additive-alias",
    "dual-read",
    "dual-write",
    "conflict-precedence",
    "journaled-copy",
    "exact-verification",
    "restart",
    "crash-recovery",
    "rollback",
    "legacy-upgrade",
    "version-negotiation",
    "compatibility-window",
    "owner-approval",
  ])
  export type Proof = typeof Proof.Type

  export const Policy = Schema.Literals([
    "raya-preferred",
    "raya-wins-legacy-write",
    "safety-monotonic-aliases",
    "explicit-or-matching-aliases",
    "legacy-canonical",
    "raya-new-only",
    "deferred-version-3",
  ])
  export type Policy = typeof Policy.Type

  export const Identity = Schema.Struct({
    kind: Schema.String,
    raya: Schema.optional(Schema.String),
    legacy: Schema.optional(Schema.String),
    policy: Policy,
  })
  export type Identity = typeof Identity.Type

  export const Baseline = Schema.Struct({
    source: Schema.Literal("script/raya-brand-inventory.json"),
    category: Schema.Literal("compatibility-key"),
    count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  })
  export type Baseline = typeof Baseline.Type

  export const Entry = Schema.Struct({
    id: Schema.String,
    area: Area,
    phase: Phase,
    identities: Schema.Array(Identity),
    required: Schema.Array(Proof),
    evidence: Schema.Array(Proof),
    cutoverReady: Schema.Literal(false),
  })
  export type Entry = typeof Entry.Type

  export const Snapshot = Schema.Struct({
    format: Schema.Literal("raya.compatibility-ledger"),
    version: Schema.Literal(1),
    policy: Schema.Tuple([
      Schema.Literal("additive-first"),
      Schema.Literal("no-in-place-rename"),
      Schema.Literal("verified-copy-before-cutover"),
    ]),
    baseline: Baseline,
    entries: Schema.Array(Entry),
  })
  export type Snapshot = typeof Snapshot.Type

  type Spec = Omit<Entry, "cutoverReady">

  const future: readonly Proof[] = [
    "dual-read",
    "dual-write",
    "conflict-precedence",
    "journaled-copy",
    "exact-verification",
    "restart",
    "crash-recovery",
    "rollback",
    "legacy-upgrade",
    "compatibility-window",
    "owner-approval",
  ]

  const env = [
    ...[
      "CONFIG",
      "CONFIG_CONTENT",
      "CONFIG_DIR",
      "AUTH_CONTENT",
      "DB",
      "GIT_BASH_PATH",
      "MODELS_PATH",
      "BIN_PATH",
      "TUI_CONFIG",
      "MODELS_URL",
      "COMMAND_TIMEOUT_MAX_MS",
      "COMMAND_TIMEOUT_MAX_MS_MESSAGE",
      "NO_DAEMON",
      "LOG_LEVEL",
      "PRINT_LOGS",
      "WEBSEARCH_PROVIDER",
      "DISABLE_PROJECT_CONFIG",
      "SESSION_RETRY_LIMIT",
      "SHOW_TTFD",
    ].map((name) => ({
      kind: `environment:${name.toLowerCase()}`,
      raya: `RAYA_${name}`,
      legacy: `KILO_${name}`,
      policy: "raya-wins-legacy-write" as const,
    })),
    {
      kind: "environment:pure",
      raya: "RAYA_PURE",
      legacy: "KILO_PURE",
      policy: "safety-monotonic-aliases" as const,
    },
    ...["SERVER_PASSWORD", "SERVER_USERNAME"].map((name) => ({
      kind: `environment:${name.toLowerCase()}`,
      raya: `RAYA_${name}`,
      legacy: `KILO_${name}`,
      policy: "explicit-or-matching-aliases" as const,
    })),
  ]

  const configs = ["config.json", "kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"].map((name) => ({
    kind: "configuration:file",
    legacy: name,
    policy: "legacy-canonical" as const,
  }))

  const packages = [
    "@kilocode/cli",
    "@kilocode/kilo",
    "@kilocode/kilo-console",
    "@kilocode/kilo-docs",
    "@kilocode/kilo-gateway",
    "@kilocode/kilo-i18n",
    "@kilocode/kilo-indexing",
    "@kilocode/kilo-jetbrains",
    "@kilocode/kilo-memory",
    "@kilocode/kilo-telemetry",
    "@kilocode/kilo-ui",
    "@kilocode/kilo-web-ui",
    "@kilocode/plugin",
    "@kilocode/plugin-atomic-chat",
    "@kilocode/sandbox",
    "@kilocode/sdk",
    "@kilocode/upstream-merge",
  ].map((name) => ({ kind: "package:name", legacy: name, policy: "legacy-canonical" as const }))

  const specs: readonly Spec[] = [
    {
      id: "cli-command",
      area: "command",
      phase: "alias-active",
      identities: [
        { kind: "manifest:bin", raya: "raya", legacy: "./bin/kilo", policy: "raya-preferred" },
        { kind: "manifest:bin", legacy: "kilo -> ./bin/kilo", policy: "legacy-canonical" },
        { kind: "manifest:bin", legacy: "kilocode -> ./bin/kilo", policy: "legacy-canonical" },
      ],
      required: [
        "additive-alias",
        "exact-verification",
        "restart",
        "rollback",
        "compatibility-window",
        "owner-approval",
      ],
      evidence: ["additive-alias", "exact-verification"],
    },
    {
      id: "environment-inputs",
      area: "environment",
      phase: "alias-active",
      identities: env,
      required: [
        "dual-read",
        "conflict-precedence",
        "exact-verification",
        "restart",
        "compatibility-window",
        "owner-approval",
      ],
      evidence: ["dual-read", "conflict-precedence", "exact-verification"],
    },
    {
      id: "configuration-sources",
      area: "configuration",
      phase: "alias-active",
      identities: [
        ...configs,
        { kind: "configuration:file", raya: "raya.json", policy: "raya-wins-legacy-write" },
        { kind: "configuration:file", raya: "raya.jsonc", policy: "raya-wins-legacy-write" },
        { kind: "configuration:directory", legacy: ".kilocode", policy: "legacy-canonical" },
        { kind: "configuration:directory", legacy: ".kilo", policy: "legacy-canonical" },
        { kind: "configuration:directory", raya: ".raya", policy: "raya-wins-legacy-write" },
        { kind: "configuration:schema", legacy: "https://app.kilo.ai/config.json", policy: "legacy-canonical" },
      ],
      required: [
        "dual-read",
        "conflict-precedence",
        "exact-verification",
        "restart",
        "rollback",
        "compatibility-window",
        "owner-approval",
      ],
      evidence: ["dual-read", "conflict-precedence", "exact-verification"],
    },
    {
      id: "physical-executable",
      area: "executable",
      phase: "legacy-canonical",
      identities: [
        { kind: "executable:path", legacy: "bin/kilo", policy: "legacy-canonical" },
        { kind: "executable:name", legacy: "kilo", policy: "legacy-canonical" },
        { kind: "executable:name", legacy: "kilo.exe", policy: "legacy-canonical" },
      ],
      required: future,
      evidence: [],
    },
    {
      id: "package-identities",
      area: "package",
      phase: "legacy-canonical",
      identities: [
        ...packages,
        {
          kind: "package:generated-platform-grammar",
          legacy: "@kilocode/cli-${platform}-${arch}[-baseline][-musl]",
          policy: "legacy-canonical",
        },
      ],
      required: future,
      evidence: [],
    },
    {
      id: "provider-identities",
      area: "provider",
      phase: "legacy-canonical",
      identities: [
        { kind: "provider:id", legacy: "kilo", policy: "legacy-canonical" },
        { kind: "gateway:auth-key", legacy: "kilo", policy: "legacy-canonical" },
      ],
      required: future,
      evidence: [],
    },
    {
      id: "http-identities",
      area: "protocol",
      phase: "legacy-canonical",
      identities: [
        { kind: "http:route-prefix", legacy: "/kilo/", policy: "legacy-canonical" },
        { kind: "http:route-prefix", legacy: "/kilocode/", policy: "legacy-canonical" },
        { kind: "http:route-prefix", raya: "/raya/", policy: "raya-new-only" },
        { kind: "http:header", legacy: "x-kilo-directory", policy: "legacy-canonical" },
        { kind: "http:header", legacy: "x-kilo-workspace", policy: "legacy-canonical" },
        { kind: "sdk:namespace", legacy: "client.kilo", policy: "legacy-canonical" },
        { kind: "sdk:namespace", legacy: "client.kilocode", policy: "legacy-canonical" },
      ],
      required: [...future, "version-negotiation"],
      evidence: [],
    },
    {
      id: "event-identities",
      area: "event",
      phase: "legacy-canonical",
      identities: [{ kind: "event:namespace", legacy: "kilocode.", policy: "legacy-canonical" }],
      required: [...future, "version-negotiation"],
      evidence: [],
    },
    {
      id: "profile-roots",
      area: "storage",
      phase: "legacy-canonical",
      identities: ["data", "cache", "config", "state", "temp"]
        .map((name) => ({
          kind: `profile:${name}`,
          legacy: `${name}:kilo`,
          policy: "legacy-canonical" as const,
        }))
        .concat({
          kind: "inventory:global-path-consumers",
          legacy: "script/global-path-consumers.json",
          policy: "legacy-canonical" as const,
        }),
      required: future,
      evidence: [],
    },
    {
      id: "database-files",
      area: "database",
      phase: "legacy-canonical",
      identities: [
        { kind: "database:stable", legacy: "kilo.db", policy: "legacy-canonical" },
        { kind: "database:channel", legacy: "kilo-${InstallationChannel}.db", policy: "legacy-canonical" },
        {
          kind: "database:channel-fallback",
          legacy: "opencode-${InstallationChannel}.db",
          policy: "legacy-canonical",
        },
      ],
      required: future,
      evidence: [],
    },
    {
      id: "credential-storage",
      area: "credential",
      phase: "legacy-canonical",
      identities: [
        { kind: "credential:file", legacy: "data-root/auth.json", policy: "legacy-canonical" },
        { kind: "credential:file", legacy: "data-root/mcp-auth.json", policy: "legacy-canonical" },
        { kind: "credential:database", legacy: "kilo.db/credential", policy: "legacy-canonical" },
        { kind: "credential:legacy-import", legacy: "home/.kilocode/cli/config.json", policy: "legacy-canonical" },
      ],
      required: future,
      evidence: [],
    },
    {
      id: "telemetry-identities",
      area: "telemetry",
      phase: "legacy-canonical",
      identities: [
        { kind: "package:name", legacy: "@kilocode/kilo-telemetry", policy: "legacy-canonical" },
        { kind: "build:environment", legacy: "KILO_VERSION", policy: "legacy-canonical" },
        { kind: "build:environment", legacy: "KILO_CHANNEL", policy: "legacy-canonical" },
        { kind: "build:environment", legacy: "KILO_BUILD_KIND", policy: "legacy-canonical" },
      ],
      required: future,
      evidence: [],
    },
    {
      id: "editor-distribution",
      area: "editor",
      phase: "deferred-version-3",
      identities: [
        { kind: "extension:id", raya: "eden.raya", policy: "raya-preferred" },
        { kind: "editor:host", legacy: "Microsoft VS Code", policy: "legacy-canonical" },
        { kind: "editor:distribution", raya: "Raya-owned editor", policy: "deferred-version-3" },
      ],
      required: [
        "exact-verification",
        "restart",
        "crash-recovery",
        "rollback",
        "legacy-upgrade",
        "compatibility-window",
        "owner-approval",
      ],
      evidence: [],
    },
  ]

  export function make(input: readonly Spec[] = specs, baseline?: Baseline): Snapshot {
    const ids = new Set<string>()
    for (const item of input) {
      if (ids.has(item.id)) throw new Error(`Duplicate migration ledger id: ${item.id}`)
      ids.add(item.id)
      if (!item.identities.length) throw new Error(`Migration ledger identities are empty: ${item.id}`)
      if (item.evidence.some((proof) => !item.required.includes(proof)))
        throw new Error(`Migration ledger evidence is not required: ${item.id}`)
    }
    return Schema.decodeUnknownSync(Snapshot)({
      format: "raya.compatibility-ledger",
      version: 1,
      policy: ["additive-first", "no-in-place-rename", "verified-copy-before-cutover"],
      baseline: baseline ?? {
        source: "script/raya-brand-inventory.json",
        category: "compatibility-key",
        count: 35_730,
        digest: "6f8d633f400b19414c29a748d3907e30ce5eecbc7651bcc82fffd1182c54e9a3",
      },
      entries: input.map((item) => ({ ...item, cutoverReady: false as const })),
    })
  }

  export const snapshot = make()
}
