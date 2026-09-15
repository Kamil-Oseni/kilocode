export namespace ProfileWriterManifest {
  export type Root = "data" | "state" | "state-parent" | "config" | "cache" | "bin" | "log" | "tmp" | "repos"
  export type Coverage = "integrated" | "declared-unintegrated" | "uncertain"
  export type CopyPolicy = "copy-after-drain" | "online-backup" | "reconstruct-after-drain" | "exclusive"

  export type Boundary = {
    id: string
    roots: readonly Root[]
    sources: readonly string[]
    methods: readonly string[]
    lifecycle: string
    copyPolicy: CopyPolicy
    coverage: Coverage
  }

  export type Maintenance = Omit<Boundary, "coverage"> & {
    mode: "exclusive-maintenance" | "exclusive-destructive"
  }

  export type Manifest = {
    format: "raya.profile-writer-manifest"
    version: 1
    complete: false
    writers: readonly Boundary[]
    maintenance: readonly Maintenance[]
    gaps: readonly string[]
  }

  const writer = (input: Boundary) => input
  const unintegrated = "declared-unintegrated" as const
  const uncertain = "uncertain" as const

  export const manifest = {
    format: "raya.profile-writer-manifest",
    version: 1,
    complete: false,
    writers: [
      writer({
        id: "profile.bin.language-servers",
        roots: ["bin"],
        sources: ["packages/opencode/src/lsp/server.ts"],
        methods: ["download", "extract", "install", "rename", "remove", "symlink"],
        lifecycle: "Hold through package-manager children, download and extraction; stop new LSP installs first.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.bin.ripgrep",
        roots: ["bin"],
        sources: ["packages/core/src/ripgrep/binary.ts"],
        methods: ["download", "extract", "publish", "cleanup"],
        lifecycle: "Hold through publication and temporary archive cleanup.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.bootstrap.roots",
        roots: ["data", "state", "config", "bin", "log", "tmp", "repos"],
        sources: [
          "packages/core/src/global.ts",
          "packages/core/src/kilocode/global.ts",
          "packages/core/src/kilocode/spotlight.ts",
        ],
        methods: ["mkdir", "repair-link", "write-probe", "unlink-probe", "no-index"],
        lifecycle: "Runs before normal DI; destination preparation belongs to the outer process controller.",
        copyPolicy: "copy-after-drain",
        coverage: uncertain,
      }),
      writer({
        id: "profile.cache.browser-uploads",
        roots: ["cache"],
        sources: ["packages/opencode/src/kilocode/browser/upload-stage.ts"],
        methods: ["stream", "publish-receipt", "prune", "release"],
        lifecycle: "Finish or cancel streams and settle capability receipts before reconstruction.",
        copyPolicy: "reconstruct-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.cache.commands",
        roots: ["cache", "config"],
        sources: ["packages/opencode/src/kilocode/command-files.ts"],
        methods: ["remove-config-command", "inspect-cache-command"],
        lifecycle: "Identify the cache producer and separate it from mutable global configuration.",
        copyPolicy: "copy-after-drain",
        coverage: uncertain,
      }),
      writer({
        id: "profile.cache.models",
        roots: ["cache"],
        sources: ["packages/core/src/models-dev.ts"],
        methods: ["populate", "rename", "remove-corrupt"],
        lifecycle: "Retain the flock and pin one cache generation through corruption recovery.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.cache.skills",
        roots: ["cache"],
        sources: ["packages/opencode/src/skill/discovery.ts", "packages/opencode/src/kilocode/skill-remove.ts"],
        methods: ["download", "stage", "rename", "backup", "remove-manifest"],
        lifecycle: "Drain discovery downloads and publication before copying.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.config.global",
        roots: ["config"],
        sources: [
          "packages/opencode/src/cli/cmd/agent.ts",
          "packages/opencode/src/cli/cmd/mcp.ts",
          "packages/opencode/src/cli/cmd/plug.ts",
          "packages/opencode/src/config/config.ts",
          "packages/opencode/src/kilocode/agent/builder.ts",
          "packages/opencode/src/kilocode/config/config.ts",
          "packages/opencode/src/kilocode/config/overlay.ts",
          "packages/opencode/src/kilocode/tui/config.ts",
          "packages/opencode/src/plugin/install.ts",
          "packages/opencode/src/plugin/tui/runtime.ts",
        ],
        methods: ["setup", "update", "install", "remove", "migrate", "repair"],
        lifecycle: "Consolidate direct writes and package-manager children behind one admitted repository.",
        copyPolicy: "copy-after-drain",
        coverage: uncertain,
      }),
      writer({
        id: "profile.credentials.auth",
        roots: ["data"],
        sources: ["packages/opencode/src/auth/index.ts"],
        methods: ["set", "remove"],
        lifecycle: "Pin auth.json through its flocked read-modify-write.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.credentials.mcp",
        roots: ["data"],
        sources: ["packages/opencode/src/mcp/auth.ts"],
        methods: ["set", "remove", "update"],
        lifecycle: "Pin mcp-auth.json through its flocked read-modify-write.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.memory",
        roots: ["data"],
        sources: ["packages/opencode/src/kilocode/memory/runtime.ts", "packages/kilo-memory/src/storage/paths.ts"],
        methods: ["configure", "write", "rename", "remove", "reset", "retain"],
        lifecycle: "Dispose and reconfigure the one-shot memory runtime, including locks and retained sessions.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.plans",
        roots: ["data"],
        sources: ["packages/opencode/src/session/session.ts", "packages/opencode/src/kilocode/plan-artifact.ts"],
        methods: ["generic-tool-write", "sidecar-write", "remove"],
        lifecycle: "Replace generic file-tool access to data/plans with an admitted repository.",
        copyPolicy: "copy-after-drain",
        coverage: uncertain,
      }),
      writer({
        id: "profile.data.repos",
        roots: ["repos"],
        sources: ["packages/opencode/src/tool/repo_clone.ts", "packages/opencode/src/util/repository.ts"],
        methods: ["clone", "fetch", "checkout", "remove"],
        lifecycle: "Retain one generation lease through each Git subprocess and cleanup.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.revert-note",
        roots: ["data"],
        sources: ["packages/opencode/src/kilocode/session/revert-note.ts"],
        methods: ["write", "unlink"],
        lifecycle: "Pin data/raya/revert-note through directory creation, write or unlink.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.self-heal",
        roots: ["data"],
        sources: ["packages/opencode/src/kilocode/self-heal/repair.ts"],
        methods: ["create-worktree", "verify", "publish", "recover", "remove"],
        lifecycle: "Hold through Git subprocess completion and protected-storage receipt settlement.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.session-export",
        roots: ["data"],
        sources: [
          "packages/opencode/src/kilocode/session-export/sequence.ts",
          "packages/opencode/src/kilocode/session-export/session-export.ts",
          "packages/opencode/src/kilocode/session-export/worker/storage.ts",
          "packages/opencode/src/kilocode/session-export/workspace-provider.ts",
        ],
        methods: ["enqueue", "worker-write", "sqlite-write", "workspace-write", "close"],
        lifecycle: "Unsubscribe, drain, receive worker shutdown acknowledgement and close every DB handle.",
        copyPolicy: "online-backup",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.snapshots",
        roots: ["data"],
        sources: ["packages/opencode/src/snapshot/index.ts"],
        methods: ["seed", "materialize", "write-object", "update-ref", "remove"],
        lifecycle: "Hold through Git subprocesses, object publication and rollback cleanup.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.tool-output",
        roots: ["data"],
        sources: ["packages/opencode/src/tool/truncate.ts", "packages/opencode/src/tool/truncation-dir.ts"],
        methods: ["write", "cleanup"],
        lifecycle: "Pin data/tool-output and interrupt or drain background cleanup before switching.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.data.worktrees",
        roots: ["data"],
        sources: ["packages/opencode/src/worktree/index.ts"],
        methods: ["create", "reset", "remove", "update-database"],
        lifecycle: "Acquire data and DB admission for the complete Git subprocess and metadata update.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.log.diagnostics",
        roots: ["log"],
        sources: [
          "packages/opencode/src/cli/cmd/run/trace.ts",
          "packages/opencode/src/cli/heap.ts",
          "packages/opencode/src/kilocode/cli/heap-snapshot.ts",
        ],
        methods: ["append-trace", "write-heap-snapshot", "publish-latest"],
        lifecycle: "Finish direct appends and native heap serialization before switching.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.log.runtime",
        roots: ["log"],
        sources: ["packages/core/src/observability/logging.ts", "packages/core/src/util/log.ts"],
        methods: ["create", "append", "rotate", "rename", "cleanup", "close"],
        lifecycle: "Flush and close both loggers; prevent rotation from reopening the old root.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.sqlite.primary.effect",
        roots: ["data"],
        sources: [
          "packages/core/src/database/database.ts",
          "packages/core/src/database/migration.ts",
          "packages/core/src/kilocode/database-compat.ts",
          "packages/core/src/kilocode/migration-backup.ts",
        ],
        methods: ["open", "migrate", "transaction", "checkpoint", "close"],
        lifecycle: "Pin before layer construction; block acquisition, drain and dispose all service instances.",
        copyPolicy: "online-backup",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.sqlite.primary.legacy",
        roots: ["data"],
        sources: ["packages/opencode/src/storage/db.ts"],
        methods: ["open", "migrate", "transaction", "checkpoint", "close"],
        lifecycle: "Reject new Client use while draining and call Database.close before backup.",
        copyPolicy: "online-backup",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.background-process",
        roots: ["state", "log"],
        sources: ["packages/opencode/src/kilocode/background-process/index.ts"],
        methods: ["write-manifest", "write-stop", "append-log", "remove", "close"],
        lifecycle: "Stop or hand off persistent children and retry timers; refuse cutover while any can write.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.daemon",
        roots: ["state", "log"],
        sources: ["packages/opencode/src/kilocode/daemon/daemon.ts"],
        methods: ["write-state", "lock", "append-log", "stop"],
        lifecycle: "Stop the daemon and verify ownership and process exit before switching.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.indexing",
        roots: ["state"],
        sources: [
          "packages/opencode/src/kilocode/indexing-worker.ts",
          "packages/opencode/src/kilocode/indexing.ts",
          "packages/opencode/src/kilocode/lancedb.ts",
        ],
        methods: ["worker-write", "vector-write", "delete", "dispose"],
        lifecycle: "Dispose the worker, receive shutdown acknowledgement and close local vector handles.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.model",
        roots: ["state"],
        sources: [
          "packages/opencode/src/cli/cmd/run/variant.shared.ts",
          "packages/opencode/src/kilocode/config/model-state.ts",
          "packages/opencode/src/kilocode/tool/task.ts",
        ],
        methods: ["save", "remove", "update"],
        lifecycle: "Consolidate all model.json mutations behind one admitted repository.",
        copyPolicy: "copy-after-drain",
        coverage: uncertain,
      }),
      writer({
        id: "profile.state.plugin-meta",
        roots: ["state"],
        sources: ["packages/opencode/src/plugin/meta.ts"],
        methods: ["save", "update"],
        lifecycle: "Pin plugin-meta.json for each complete read-modify-write.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.sandbox-policy",
        roots: ["state-parent"],
        sources: ["packages/opencode/src/kilocode/sandbox/store.ts"],
        methods: ["write", "remove", "dispose"],
        lifecycle: "Pin the kilo-sandbox-policy compatibility root for the complete operation.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.sandbox-preference",
        roots: ["state-parent"],
        sources: ["packages/opencode/src/kilocode/sandbox/preference.ts"],
        methods: ["write"],
        lifecycle: "Pin the kilo-sandbox-preference compatibility root for the complete operation.",
        copyPolicy: "copy-after-drain",
        coverage: unintegrated,
      }),
      writer({
        id: "profile.state.tui-kv",
        roots: ["state"],
        sources: ["packages/tui/src/context/kv.tsx", "packages/tui/src/util/persistence.ts"],
        methods: ["queue-write", "atomic-publish", "close"],
        lifecycle: "Expose an acknowledgement for the fire-and-forget queue and await it before switching.",
        copyPolicy: "copy-after-drain",
        coverage: uncertain,
      }),
      writer({
        id: "profile.storage.json",
        roots: ["data"],
        sources: ["packages/opencode/src/storage/storage.ts"],
        methods: ["initialize", "migrate", "create", "replace", "write", "update", "remove"],
        lifecycle: "Admit lazy migrations and marker writes as well as every public mutation method.",
        copyPolicy: "copy-after-drain",
        coverage: "integrated",
      }),
      writer({
        id: "profile.tmp.attachments",
        roots: ["tmp"],
        sources: ["packages/opencode/src/kilocode/remote-attachments.ts"],
        methods: ["mkdir", "write", "remove", "dispose"],
        lifecycle: "Use the existing dispose wait to finish or cancel active scratch writes.",
        copyPolicy: "reconstruct-after-drain",
        coverage: unintegrated,
      }),
    ],
    maintenance: [
      {
        id: "profile.maintenance.legacy-storage-migration",
        roots: ["data"],
        sources: ["packages/opencode/src/kilocode/storage/json-migration.ts"],
        methods: ["read-json-storage", "raw-sqlite-transaction", "write-marker"],
        lifecycle: "Acquire JSON storage and both DB boundaries; never overlap cutover.",
        copyPolicy: "exclusive",
        mode: "exclusive-maintenance",
      },
      {
        id: "profile.maintenance.uninstall",
        roots: ["data", "state", "config", "cache"],
        sources: ["packages/opencode/src/cli/cmd/uninstall.ts"],
        methods: ["remove-profile-roots", "remove-package"],
        lifecycle: "Acquire exclusive quiescence; successful uninstall must not reopen admission.",
        copyPolicy: "exclusive",
        mode: "exclusive-destructive",
      },
    ],
    gaps: [
      "generic shell and process tools can inherit profile temporary and binary paths",
      "cross-process flock and lock-file writers are outside the in-process registry",
      "environment and injected roots can place stores outside the default profile",
      "direct and parameter-injected SQL writers require coverage through both clients",
      "a static mutation-candidate guard and cross-process ownership protocol are not implemented",
    ],
  } as const satisfies Manifest
}
