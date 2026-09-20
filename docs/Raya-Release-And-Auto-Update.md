# Raya Release & Auto-Update

Raya is distributed outside the VS Code Marketplace. Instead of publishing to Microsoft's gallery, every build is packaged as a `.vsix` and attached to a GitHub Release, and the extension itself watches that repository for newer releases and offers to install them. This gives a private, gated distribution channel — access follows the repository's visibility, so a private repo means only authenticated people can download a build — while still delivering a familiar "an update is available" experience inside the editor. Nothing here touches the Marketplace or Open VSX, and there is no password on a release: the gate is repository access.

The system has two halves. The **producing** side is a GitHub Actions workflow that turns a version tag into a published Release. The **consuming** side is a small update checker inside the extension that polls that Release and installs the matching VSIX. They are independent — you can build releases without anyone using the checker, and the checker degrades quietly if no repository is configured.

## Cutting a release

Publishing a new build is a single tagged push:

```bash
git tag raya-v7.4.24
git push origin raya-v7.4.24
```

The tag must match `raya-v*`. Pushing it triggers the `raya-release` workflow (`.github/workflows/raya-release.yml`), which builds a platform-specific `.vsix` on native runners for each of `win32-x64`, `darwin-arm64`, and `linux-x64`, then creates a GitHub Release for the tag with all three files attached. The release title is derived from the tag, and release notes are auto-generated from the commits since the previous tag. If the tag carries a prerelease suffix — for example `raya-v7.4.24-beta.1` — the Release is marked as a prerelease so the update checker can be told to ignore it by default.

Because GitHub Releases inherit the repository's visibility, keeping the repo private makes both the Release and its `.vsix` assets private; downloading them then requires an authenticated GitHub identity. That is the whole of the "unlisted / password" story: there is no separate secret, only repo access.

## How the workflow builds each VSIX

The workflow reuses the same build pipeline as local development rather than duplicating it. Each matrix job checks out the repo, sets up Bun (the shared `setup-bun` composite action, which installs dependencies across Windows, macOS, and Linux), and on Linux additionally installs Zig for the sandbox helper. It then resolves the plain `x.y.z` version from the tag and runs the extension's release build:

```bash
bun run release:evidence
```

The runner (`packages/kilo-vscode/script/release-evidence.ts`) first requires a clean tracked checkout and records the full source commit, native host and pinned Bun version. It executes the support-contract, architecture, workflow, test-inventory, generated-state, Effect-facade, changeset and migration gates sequentially. It then calls `packages/kilo-vscode/script/dev-snapshot.ts` in release mode to prepare the SDK, compile the CLI for the runner's own platform, run the production validation build, and package a platform-tagged VSIX into `packages/kilo-vscode/out/`.

After packaging, the runner reads the VSIX without executing or extracting it. It verifies both embedded manifests against `eden.raya`, the requested version and native target; requires the bundled CLI; rejects `.env` and `.tmp` entries; records archive, CLI and entry sizes; streams a SHA-256 digest; and fails if generation changed tracked source. The adjacent `raya-<target>.evidence.json` identifies every executed command, status and duration. Installation is explicitly `not-run` in CI receipts because packaging on a hosted runner is not clean-install evidence.

Two environment variables drive it:

- `RAYA_RELEASE_VERSION` — the version to stamp into the VSIX. Any `raya-`/`v` prefix and any prerelease or build suffix are stripped, because `vsce` only accepts a bare `major.minor.patch` version. The GitHub Release tag still carries the full name, so prerelease identity is preserved at the release level even though the packaged version is the semver core.
- `RAYA_VSCE_TARGET` — the platform target (e.g. `win32-x64`). This is written into the VSIX so VS Code installs the correct build on each machine and refuses a mismatched one.

Each job uploads its `.vsix` and matching evidence JSON as workflow artifacts; a final job downloads all of them and runs `gh release create` to publish the Release with both artifact types. Building natively per platform (rather than cross-compiling) keeps the workflow simple and avoids Docker/QEMU, at the cost of covering only the three common targets above. Other architectures are not built.

You can produce a release VSIX locally the same way the workflow does, which is useful for testing the artifact before tagging:

```bash
RAYA_RELEASE_VERSION=7.4.24 RAYA_VSCE_TARGET=win32-x64 bun run release:evidence
# → packages/kilo-vscode/out/raya-win32-x64.vsix
```

The command writes both `packages/kilo-vscode/out/raya-win32-x64.vsix` and `packages/kilo-vscode/out/raya-win32-x64.evidence.json`. Run `bun run release:evidence --plan` to inspect the ordered release-specific gates without executing them or building an artifact. A plan is not passing evidence. Package tests affected by a change and the normal pull-request checks remain required; the release receipt does not turn an untested source revision into an approved release.

The new workflow file is registered in `script/check-workflows.ts`; that CI guard fails if a workflow is added or removed without updating the list, which is how the repo keeps upstream-merged workflows from silently running.

## Clean-install evidence

Each supported platform still needs an installation receipt produced from the exact published VSIX. On a clean VS Code profile, install the platform asset, reload the extension host, confirm `eden.raya` and the packaged version through the editor's installed-extension inventory, start its bundled backend, and run the representative task and recovery checks listed in the implementation ledger. Record the source commit, runner, VS Code version, artifact SHA-256, installed identity, backend version, checks exercised and every skipped or failed check. Only then may the support contract change that target from `unverified` to verified installation evidence.

## Rollback

Do not overwrite or delete the previous GitHub Release when publishing a new one. If installation, activation, bundled-backend startup or a representative recovery check fails, retain the failing evidence receipt, disable automatic update for the affected client, reinstall the previous verified platform VSIX, reload VS Code, and confirm its extension and backend identities before resuming work. Record both artifact hashes and the reason for rollback in `docs/Raya-Implementation-Progress.md`. If the failure may have changed stored data, export recovery state before reinstalling and follow `docs/Raya-Database-Recovery.md`; installing an older extension is not proof that newer database state is backward-compatible.

## How the update checker works

The checker lives in `packages/kilo-vscode/src/services/update-checker.ts` and is wired into extension activation. Shortly after the editor starts, and then on a six-hour interval while the window stays open, it queries the configured repository's Releases through the GitHub API, selects the newest eligible release, and compares its version to the installed extension version. If a newer version exists, it shows a non-blocking notification offering **Install**, **View Release**, or **Later**.

Choosing **Install** first verifies that the package vault contains exactly one package for the active extension version and platform and that its bundled CLI receipt matches the CLI this host is actually running. If that rollback package is absent, ambiguous or changed, Raya stops before downloading or dispatching an installer. The verified prior VSIX is copied into the update journal's private storage, independently of package-vault pruning. Raya then downloads the `.vsix` whose name matches the current platform target, verifies its declared size, SHA-256 digest, extension manifests and bundled CLI, retains it in the package vault and installs that retained path through VS Code's `workbench.extensions.installExtension` command.

The durable install record distinguishes intent, acknowledged dispatch, rollback dispatch and uncertain rollback acknowledgement. A lost response is never replayed. After restart, Raya clears the record only when the package-vault receipt for the running version and the installed CLI bytes exactly match the intended target. If activation cannot be verified, the recovery notice offers reload or **Restore previous**. Restore re-verifies the journal-owned prior package before recording rollback intent, dispatches it at most once across extension windows and clears the record only after a fresh host verifies the prior package and CLI. Legacy records remain diagnostic and cannot authorize rollback because they lack the prior receipt.

**View Release** opens the release page in a browser. **Later** records the version so you are not prompted again for that same release; a genuinely newer version later on will prompt again. Network and API failures are recorded in the "Raya Updates" output channel without response bodies or credentials. Manual checks surface an actionable error. Version comparison ignores prefixes and build metadata and treats a full release as newer than its own prerelease, so a `-snapshot`/`-beta` installed build compares sensibly against a clean release tag.

There is also a manual **"Raya: Check for Updates"** command in the command palette. Run manually, it always reports the outcome — including "up to date" or "no releases found" — whereas the background check stays silent unless something is actually newer.

Because the checker ships *inside* the extension, it only becomes active once you are running a build that contains it. The first time, install such a build manually (either from a tagged release or by running `bun run snapshot:install` locally); from then on it can pull subsequent releases itself.

## Configuration

The checker is controlled by these settings (all under the Raya section, application scope):

- `raya.update.enabled` — master switch for background checks. Default `true`. The manual command still works when this is off.
- `raya.update.repo` — the GitHub repository as `owner/name`, e.g. `eden/raya`. **Required**; the checker does nothing until this is set.
- **Raya: Set Update Token** — stores or removes the optional GitHub personal access token through VS Code SecretStorage. It is needed only to read Releases and download assets from a **private** repository. Public repositories need no token. Older `raya.update.token` values are migrated from global, workspace and workspace-folder settings only when all populated scopes agree and the encrypted write verifies; successful migration removes every legacy setting. Conflicts or cleanup failures stop the update check without logging the credential.
- `raya.update.includePrereleases` — when `true`, prerelease Releases are also offered. Default `false`.

A typical private-repo setup is: set `raya.update.repo` to your slug, generate a fine-grained token with read access to that repo, run **Raya: Set Update Token**, and leave the rest at defaults. HTTP 401 or 403 responses stop the check or download before installation and report only the status; Raya never places the token or Authorization header in the error.

## Limitations and notes

The Marketplace is not involved, so there is no server-side update push; updates are pull-based and require the extension to already contain the checker. Only `win32-x64`, `darwin-arm64`, and `linux-x64` VSIXes are built, so other platforms must build locally. Prerelease tags publish a prerelease Release but package a plain `x.y.z` VSIX version, which means two prereleases of the same core version carry the same packaged version. Finally, a "private" release is only as private as the repository — GitHub has no per-release password, so gate distribution by keeping the repository private and sharing access deliberately.
