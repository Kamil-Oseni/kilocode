# Raya clients, distribution and feature coverage

This is the repository's Raya support baseline, checked against product checkpoint `a05a539dec` on 9 September 2026. It records implemented distribution and validation evidence; it does not establish a company support SLA. The [implementation progress log](Raya-Implementation-Progress.md) records later checkpoints and remaining acceptance work.

For Raya, use the **`eden.raya` VS Code extension from this fork**. The Kilo Marketplace, npm and cloud links in inherited documentation refer to upstream products. Installing those products does not install this fork's Raya features or updates.

## Client status

| Surface | Raya status | Distribution and backend | Validation boundary |
|---|---|---|---|
| VS Code sidebar, editor tabs and Agent Manager | Primary implementation and rollout surface | `eden.raya` VSIX with the CLI and generated SDK built from the same source checkout | Windows x64 snapshot build and installation verified. Individual workflow checks and remaining live checks are recorded in the progress log. |
| CLI and terminal UI | Implemented engine and developer-facing client | Fork source or the CLI bundled with the matching Raya VSIX; command names remain `kilo` and `kilocode` | Windows compiled CLI smoke checks and scoped runtime/TUI tests passed. No independent Raya CLI release channel is established by the Raya VSIX workflow. |
| Local web console | Implemented secondary client; experimental Raya parity | Console assets are built into the CLI; use the corresponding backend build | Production asset compilation is verified. Compilation does not establish parity with the VS Code host or full browser workflow acceptance. |
| JetBrains plugin | Maintained inherited integration; Raya distribution not established | Kilo plugin; development builds download its pinned CLI, production builds can bundle CLI binaries | Cross-package JetBrains generation/type checks passed. No Raya-branded plugin installation or feature-parity acceptance is claimed. |
| Zed integration | Inherited integration manifest | Kilo/OpenCode-named ACP targets referencing upstream release archives | Manifest presence is not a tested Raya distribution. No Raya installation/parity evidence is recorded. |
| Mobile companion | Planned | [Build plan](Raya-Mobile-Companion-Plan.md); no delivered client counted | No installable companion or mobile acceptance evidence. |
| Upstream cloud agent, reviews and KiloClaw | External upstream offerings | Upstream services linked from inherited documentation | Not Raya deployments or a way to access this fork's local session store. |

Source: [extension identity](../packages/kilo-vscode/package.json), [CLI package](../packages/opencode/package.json), [console package](../packages/kilo-console/package.json), [JetBrains build instructions](../packages/kilo-jetbrains/README.md), [Zed manifest](../packages/extensions/zed/extension.toml).

## Platforms and installation

The [Raya release workflow](../.github/workflows/raya-release.yml) declares three platform targets. A configured build target is distinct from a published asset or a successful installation.

| Platform | Expected release asset | Evidence at this baseline |
|---|---|---|
| Windows x64 | `raya-win32-x64.vsix` | Local snapshot production build, archive inspection and VS Code installation verified. |
| macOS Apple Silicon | `raya-darwin-arm64.vsix` | Release job configured; this audit does not certify a macOS installation. |
| Linux x64 | `raya-linux-x64.vsix` | Release job configured; this audit does not certify a Linux installation. |
| macOS Intel, Windows ARM64, Linux ARM64, other targets | No Raya asset declared by this workflow | CLI build capabilities and upstream assets do not establish Raya VSIX support for these targets. |

The extension manifest requires **VS Code `^1.106.0`**. This requirement alone does not certify every VS Code derivative, remote extension host or browser-hosted editor. The native CLI and browser host need to run on the extension host's platform; remote/WSL/container combinations require their own end-to-end checks before being added to this matrix.

For an internal release, obtain the exact platform VSIX from the configured fork repository's `raya-vX.Y.Z` release and install it through VS Code's **Extensions: Install from VSIX** command. Confirm the publisher/name is `eden.raya`. The extension's updater uses `raya.update.repo`, `raya.update.enabled` and the explicit prerelease setting; a repository being configured does not prove that an eligible asset exists.

For a local development checkpoint, the existing command from the repository root is:

```powershell
bun run --cwd packages/kilo-vscode snapshot:install
```

That command builds and validates the CLI/extension, packages a uniquely versioned snapshot and replaces the installed extension. It is not a read-only check. Use the recorded source commit and artifact hash to identify a snapshot; its CLI development version can differ from the extension's snapshot version. A successful install may still require **Developer: Reload Window** before the active extension host uses the new files.

## Backend and authentication contract

The supported baseline for the primary client is the **SDK, CLI and extension produced by the same Raya build**. Do not substitute an arbitrary globally installed `kilo` binary and infer compatibility from the command name or matching package major version. Generated types are build-time contracts; they are not runtime feature negotiation.

| Client path | Connection and credentials | Compatibility boundary |
|---|---|---|
| VS Code local backend | The extension starts its backend, generates a random password and connects over loopback HTTP with Basic authentication | One connection service is shared by sidebar, editor tabs and Agent Manager within the extension host. Worktree directory context does not imply a separate backend process. |
| Direct CLI/TUI | Local process using its configured provider credentials and state | Use this fork's source/binary when expecting Raya runtime features. Provider credentials remain separate from private-release credentials. |
| Manually started `kilo serve` / local console | Standalone server configuration; the serve command warns when `KILO_SERVER_PASSWORD` is absent | An independently started server does not inherit the extension-generated password. Arbitrary remote/backend-version combinations are not covered by the primary-client baseline. |
| Private VSIX updates | GitHub release access credential stored through VS Code SecretStorage; existing setting migration is handled by the updater | This credential authorizes release retrieval, not model use, browser accounts or backend sessions. |

Source: [server manager](../packages/kilo-vscode/src/services/cli-backend/server-manager.ts), [connection service](../packages/kilo-vscode/src/services/cli-backend/connection-service.ts), [serve command](../packages/opencode/src/cli/cmd/serve.ts), [update credentials](../packages/kilo-vscode/src/services/update-credentials.ts), [update checker](../packages/kilo-vscode/src/services/update-checker.ts).

A public network deployment is not established by the existence of an HTTP API, console or mobile plan. The full topology and supported-version negotiation remain open under EN-10 and EN-07. Keep any deployment claim tied to its own documented authentication, origin, permission and lifecycle acceptance.

## Feature differences

“Implemented” below means code and the stated integration exist. It does not mean that an entire audit overhaul is complete.

| Capability | Primary VS Code client | Fork CLI/TUI | Other clients |
|---|---|---|---|
| Chat, tools and subagents | Shared CLI runtime plus editor integration | Shared runtime and terminal presentation | Core chat exists in other clients; Raya-specific presentation/parity needs separate validation. |
| Goals and evidence | Goal controls, history/evidence views and persisted runtime checks | Runtime goal tools are available; do not expect identical UI | No full Raya goal-control parity certification. |
| Routines | Structured schedule controls and persisted runtime execution | Runtime services exist; not the same scheduling editor | Full routine lifecycle/parity remains open. |
| File review | Editor/chat Keep/Undo flows with acknowledgement and revision checks | Runtime operations exist; VS Code gutter/review UI is host-specific | Do not equate a generic diff viewer with the same review contract. |
| Browser automation | Extension-owned browser sessions, frames, dialogs, task-bound transfer receipts and verified download copies | Host-backed operations require an available browser bridge; a bare CLI process does not supply the VS Code browser panel | No browser-host parity established. Authorized uploads are the next implementation slice. |
| Canvas | Extension renderer and persisted candidate/current recovery | Host-backed rendering is not supplied by the terminal itself | Other canvas/preview components do not establish the same recovery contract. |
| Model costs | Session-family/project summaries and stored calculation disclosure | TUI family summary, direct-run observed-step footer and selected-session CLI statistics | These cover settled model steps; separately billed media/tools, complete reconciliation and all consumer parity remain open. |
| Voice | Existing speech/voice implementation | No matching voice UI baseline | Native realtime multimodal overhaul and client parity remain open. |
| Self-heal | Repair state, isolated worktree completion and captured-source verification | Runtime tools/check receipts | Captured input does not prove a released, installed or successfully activated repair artifact. Build/install linkage remains open. |

For detailed guarantees and limitations, see [review contract](Raya-Review-Contract.md), [cost accounting](Raya-Cost-Accounting.md), [repair verification](Raya-Self-Heal-Verification.md) and the [full audit](Raya-Comprehensive-Audit.md).

## Maintaining this contract

Update this matrix when changing extension identity, minimum VS Code version, release targets, backend selection/authentication, or a host-dependent feature. Record source commit, platform, build/check results, artifact identity and installation evidence in the progress log. Add a platform/client to the verified baseline only after its actual build, install and representative task/recovery flows pass; a green typecheck is not sufficient.

PR-06's documentation gap is addressed by this matrix and the README entry point. Company support ownership/SLA, non-Windows rollout evidence, older backend negotiation, and full per-client acceptance remain explicit product/release decisions rather than inferred support promises.
