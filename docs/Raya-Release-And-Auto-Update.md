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
bun run snapshot:release
```

That script (`packages/kilo-vscode/script/dev-snapshot.ts` in `release` mode) prepares the SDK, compiles the CLI binary for the runner's own platform, runs the production validation build, and packages a platform-tagged VSIX into `packages/kilo-vscode/out/`. Two environment variables drive it:

- `RAYA_RELEASE_VERSION` — the version to stamp into the VSIX. Any `raya-`/`v` prefix and any prerelease or build suffix are stripped, because `vsce` only accepts a bare `major.minor.patch` version. The GitHub Release tag still carries the full name, so prerelease identity is preserved at the release level even though the packaged version is the semver core.
- `RAYA_VSCE_TARGET` — the platform target (e.g. `win32-x64`). This is written into the VSIX so VS Code installs the correct build on each machine and refuses a mismatched one.

Each job uploads its `.vsix` as a workflow artifact; a final job downloads all of them and runs `gh release create` to publish the Release with the assets. Building natively per platform (rather than cross-compiling) keeps the workflow simple and avoids Docker/QEMU, at the cost of covering only the three common targets above. Other architectures are not built.

You can produce a release VSIX locally the same way the workflow does, which is useful for testing the artifact before tagging:

```bash
cd packages/kilo-vscode
RAYA_RELEASE_VERSION=7.4.24 RAYA_VSCE_TARGET=win32-x64 bun run snapshot:release
# → packages/kilo-vscode/out/raya-win32-x64.vsix
```

The new workflow file is registered in `script/check-workflows.ts`; that CI guard fails if a workflow is added or removed without updating the list, which is how the repo keeps upstream-merged workflows from silently running.

## How the update checker works

The checker lives in `packages/kilo-vscode/src/services/update-checker.ts` and is wired into extension activation. Shortly after the editor starts, and then on a six-hour interval while the window stays open, it queries the configured repository's Releases through the GitHub API, selects the newest eligible release, and compares its version to the installed extension version. If a newer version exists, it shows a non-blocking notification offering **Install**, **View Release**, or **Later**.

Choosing **Install** downloads the `.vsix` whose name matches the current platform target, installs it through VS Code's own `workbench.extensions.installExtension` command, and then offers to reload the window so the new build takes effect. **View Release** opens the release page in a browser. **Later** records the version so you are not prompted again for that same release; a genuinely newer version later on will prompt again. Any network or API failure is logged to the "Raya Updates" output channel and otherwise ignored, so a flaky connection never interrupts your work. Version comparison ignores prefixes and build metadata and treats a full release as newer than its own prerelease, so a `-snapshot`/`-beta` installed build compares sensibly against a clean release tag.

There is also a manual **"Raya: Check for Updates"** command in the command palette. Run manually, it always reports the outcome — including "up to date" or "no releases found" — whereas the background check stays silent unless something is actually newer.

Because the checker ships *inside* the extension, it only becomes active once you are running a build that contains it. The first time, install such a build manually (either from a tagged release or by running `bun run snapshot:install` locally); from then on it can pull subsequent releases itself.

## Configuration

The checker is controlled by these settings (all under the Raya section, application scope):

- `raya.update.enabled` — master switch for background checks. Default `true`. The manual command still works when this is off.
- `raya.update.repo` — the GitHub repository as `owner/name`, e.g. `eden/raya`. **Required**; the checker does nothing until this is set.
- `raya.update.token` — an optional GitHub personal access token with read access, needed only to read Releases and download assets from a **private** repository. Public repositories need no token.
- `raya.update.includePrereleases` — when `true`, prerelease Releases are also offered. Default `false`.

A typical private-repo setup is: set `raya.update.repo` to your slug, generate a fine-grained token with read access to that repo and put it in `raya.update.token`, and leave the rest at defaults.

## Limitations and notes

The Marketplace is not involved, so there is no server-side update push; updates are pull-based and require the extension to already contain the checker. Only `win32-x64`, `darwin-arm64`, and `linux-x64` VSIXes are built, so other platforms must build locally. Prerelease tags publish a prerelease Release but package a plain `x.y.z` VSIX version, which means two prereleases of the same core version carry the same packaged version. Finally, a "private" release is only as private as the repository — GitHub has no per-release password, so gate distribution by keeping the repository private and sharing access deliberately.
