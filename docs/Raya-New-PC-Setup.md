# Raya source setup on a new Windows PC

This guide moves the **tracked source, tests and documents** through Git. It does not migrate Raya's private chat, worker or credential state. Read [implementation progress](Raya-Implementation-Progress.md) before using the new installation as the only copy of your work.

## Install build prerequisites

1. Install [Git for Windows](https://git-scm.com/install/windows) and [VS Code](https://code.visualstudio.com/docs/setup/windows). Sign into GitHub in your normal browser; Git may prompt you to authenticate when cloning this repository. Never paste a token into chat.
2. Install [Bun 1.4.2](https://bun.com/docs/installation), the version pinned by root `package.json`. In PowerShell:

   ```powershell
   iex "& {$(irm https://bun.com/install.ps1)} -Version 1.4.2"
   ```

   Open a fresh PowerShell window and verify `bun --version` prints `1.4.2`. If it is not on `PATH`, follow Bun's Windows PATH instructions in the linked guide.
3. For a Windows x64 VSIX with Raya's native process, desktop capture, input and accessibility helpers, install **Visual Studio 2022 Build Tools**, the **Desktop development with C++** workload and a Windows SDK from [Microsoft](https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc?view=msvc-170). Current build scripts specifically expect `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`. A different install layout needs a build-script change before packaging.

## Clone and verify the exact source

In a fresh PowerShell window, choose an empty destination. This example recreates the familiar `Desktop\raya` folder under the new Windows user profile:

```powershell
$rayaRoot = Join-Path $env:USERPROFILE 'Desktop\raya'
git clone --branch main https://github.com/Kamil-Oseni/kilocode.git $rayaRoot
Set-Location -LiteralPath $rayaRoot
git rev-parse HEAD
git status --short
bun install --frozen-lockfile
```

Compare `git rev-parse HEAD` with the commit reported in the handoff chat. `git status --short` should be empty just after cloning. Bun's root postinstall prepares the native terminal dependency and local Git settings.

For an **existing** clone on the new PC, use this instead of cloning over it:

```powershell
Set-Location -LiteralPath (Join-Path $env:USERPROFILE 'Desktop\raya')
git fetch origin
git switch main
git pull --ff-only origin main
git rev-parse HEAD
bun install --frozen-lockfile
```

If `git pull --ff-only` refuses because the destination has local edits or divergent commits, preserve them and resolve that Git state before updating. Do not reset the new PC checkout just to match the remote.

## Build and start Raya

For implementation work in a separate, persistent VS Code extension development profile, run this from the repository root:

```powershell
bun run extension:isolated -- $rayaRoot
```

It builds and launches VS Code with `.kilo-dev/` state in the checkout. `extension:isolated:clean` deletes that isolated development profile; do not use it when preserving its chats. To build an installable Windows x64 VSIX from the exact checkout instead:

```powershell
$env:RAYA_LOW_MEMORY = '1'
bun run --cwd packages/kilo-vscode snapshot:build
```

The build prints its unique VSIX path under the Windows temporary `raya-vscode-snapshots` folder. After it succeeds, install **that exact printed file** in VS Code using `code --install-extension '<full path to printed .vsix>' --force`, or use VS Code's *Extensions: Install from VSIX* command. Confirm the running extension reports the same source commit before testing. The VSIX and local dependencies are generated on this PC and are not Git files.

## Local data and next acceptance gate

Git excludes `.kilo-dev/`, `.tmp/`, dependencies, VSIX artifacts, databases, local JSON settings, secrets and model weights. The Codex conversation surviving account/device login does not itself copy Raya's on-disk chats, drafts, organizations, worker state or schedules. Keep the old PC and its Raya profile intact. Do not run old and copied scheduled workers simultaneously or manually copy a live SQLite/JSON subset; portable capture and restore is still blocked by the [writer audit](Raya-Portable-Capture-Writer-Audit.md).

For now, sign into or configure the providers you want on the new PC, begin with a new test chat and a bounded local-model request, then test a safe worker/routine with no live external side effects. Installing or reaching a model endpoint alone does not prove local inference, restart survival, or safe worker continuation. The remaining implementation should first complete coordinated profile capture/restore, then verify a source-matched installed VSIX with a real local inference server and restart/reinstall tests. See the [progress doc](Raya-Implementation-Progress.md) for the current readiness score and open gates.
