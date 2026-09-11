# Raya clients, distribution and feature coverage

This is the repository's Raya support baseline, checked against packaged product checkpoint `932b20497e4c88b9965861ef713265bbe028256d` on 10 September 2026. It records implemented distribution and validation evidence; it does not establish a company support SLA. The [implementation progress log](Raya-Implementation-Progress.md) records later checkpoints and remaining acceptance work.

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

<!-- raya-support:start -->
Extension: **`eden.raya`**. Minimum editor range: **VS Code `^1.106.0`**. Backend compatibility: SDK, CLI and extension from the same source build.

| Build target | Runner | Expected release asset | Installation evidence |
|---|---|---|---|
| `win32-x64` | `windows-latest` | `raya-win32-x64.vsix` | Local checkpoint only; not certification of a future release asset. |
| `darwin-arm64` | `macos-latest` | `raya-darwin-arm64.vsix` | Unverified; configured build target only. |
| `linux-x64` | `ubuntu-latest` | `raya-linux-x64.vsix` | Unverified; configured build target only. |

Local installation evidence: `932b20497e4c88b9965861ef713265bbe028256d` (2026-09-10), `win32-x64`; VSIX SHA-256 `74e6a11f16f7388c286590f83f0d350c262051dbe996652c8fae8d2f8a8cf66f`. See the [delivery record](Raya-Implementation-Progress.md). This records packaging and installation, not all live workflows or activation after reload.
<!-- raya-support:end -->

No other Raya VSIX targets are declared. CLI build capabilities and upstream assets do not establish additional Raya client support.

This requirement alone does not certify every VS Code derivative, remote extension host or browser-hosted editor. The native CLI and browser host need to run on the extension host's platform; remote/WSL/container combinations require their own end-to-end checks before being added to this matrix.

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
| Browser automation | Extension-owned browser sessions, frames, dialogs, task-bound transfer receipts and verified download copies | Host-backed operations require an available browser bridge; a bare CLI process does not supply the VS Code browser panel | No browser-host parity established. Authorized, task-bound file uploads are implemented; file selection and destination acceptance are separate receipts. No cross-client upload parity is claimed. |
| Canvas | Extension renderer and persisted candidate/current recovery | Host-backed rendering is not supplied by the terminal itself | Other canvas/preview components do not establish the same recovery contract. |
| Model costs | Session-family/project summaries and stored calculation disclosure | TUI family summary, direct-run observed-step footer and selected-session CLI statistics | Settled model-step accounting and native voice provider usage receipts remain distinct; complete media/tool billing reconciliation and all consumer parity remain open. |
| Voice | OpenAI native voice default with explicit microphone start, mute, Stop speaking, End voice, selected-image sharing, usage disclosure, saved-task context and explicit restart. Admitted work continues independently; task-linked voice retention is deleted with the task. | No matching voice UI baseline | Local transport, HTTP/WebSocket and actual UI fixtures are verified. Paid-provider/microphone acceptance, acoustic quality, durable spoken history and warm handoff remain unverified or unimplemented. |
| Self-heal | Repair state, isolated worktree completion, captured-source verification and retained artifact build/inspection receipts | Runtime tools and source/artifact receipts | A real repair VSIX was built and independently inspected. Its originating helper required a watchdog exit; publication, installation, rollback and post-install acceptance remain unverified. Ordinary snapshot installation does not establish repair installation. |

For detailed guarantees and limitations, see [review contract](Raya-Review-Contract.md), [cost accounting](Raya-Cost-Accounting.md), [repair verification](Raya-Self-Heal-Verification.md) and the [full audit](Raya-Comprehensive-Audit.md).

## Maintaining this contract

Update this matrix when changing extension identity, minimum VS Code version, release targets, backend selection/authentication, or a host-dependent feature. Record source commit, platform, build/check results, artifact identity and installation evidence in the progress log. Add a platform/client to the verified baseline only after its actual build, install and representative task/recovery flows pass; a green typecheck is not sufficient.

The [machine-readable contract](Raya-Support-Contract.json) owns identity, editor range, configured targets and checkpoint evidence. `bun run script/kilocode/raya-support.ts` checks the manifest, release workflow and generated block above; `--write` refreshes that block after an intentional contract update. Existing CI runs the guard and its drift tests, and release builds validate it before packaging. Release notes link this matrix at the checked-out source commit and distinguish build targets from verified installations. Feature coverage outside the generated block still requires source and acceptance review.

PR-06's documentation and distribution-contract gap is addressed by this matrix, guard and README entry point. Company support ownership/SLA, non-Windows rollout evidence, older backend negotiation, and full per-client acceptance remain explicit product/release decisions rather than inferred support promises.
