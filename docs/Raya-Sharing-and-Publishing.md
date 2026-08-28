# Sharing and Publishing Raya

Raya is a VS Code extension packaged as a `.vsix` file. There are two ways to get it
onto other machines, and they answer two different needs. Sharing the `.vsix` with
your developers keeps Raya completely private and under your control. Publishing to a
marketplace makes it searchable by anyone, which is public by definition. This doc
covers both, and the honest trade-offs.

## Use the build you already have

You usually do not need to rebuild before sharing. Every time you run `snapshot:build`
or `snapshot:install`, the packaged `.vsix` is left in `%TEMP%\raya-vscode-snapshots`,
named `raya-vscode-snapshot-<commit>-<user>-<timestamp>.vsix`. The commit in the name
tells you how current a given file is, and the newest one is normally the build you last
installed. Because Windows can clear the temp folder, copy the one you want somewhere
permanent before sharing.

The most complete build at the time of writing is commit `ca0fd240cc`, which includes
the goal, routing, browser, smoke, canvas, voice, and settings-hub milestones. It has
been copied to `C:\Users\User\Desktop\raya\Raya-latest.vsix` (about 530 MB), ready to
hand to your developers. That path is gitignored through the `*.vsix` rule so the
half-gigabyte binary never lands in the repo; share it through a shared drive or a
private release rather than committing it. When you cut a newer build, replace
`Raya-latest.vsix` with it and send that.

## Build a fresh VSIX

From the fork at `C:\Users\User\Desktop\raya`, build the extension package:

```
cd packages/kilo-vscode
bun run snapshot:build
```

This validates the production build and writes a `.vsix` into your system temp folder
under `raya-vscode-snapshots`, named like
`raya-vscode-snapshot-<commit>-<user>-<timestamp>.vsix`. The build does not print the
final path, so grab the newest file with:

```
Get-ChildItem "$env:TEMP\raya-vscode-snapshots" -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName
```

One thing to expect: the file is large, roughly half a gigabyte, because Raya bundles
its CLI binary, the Playwright browser runtime, and the canvas compiler inside the
package. That is too big to email, so share it through a shared drive, an internal
file server, or a private GitHub release rather than as an attachment.

## Give it to your developers

Your developers do not need Raya to be searchable. They install the `.vsix` you send
them directly. In VS Code or Cursor, open the Extensions panel, click the "..." menu
at the top, choose "Install from VSIX...", and pick the file. The command line works
too:

```
code --install-extension "path\to\raya-vscode-snapshot-....vsix"
```

That is the whole flow. The extension appears installed with `Source: VSIX`, exactly
like yours, and it stays invisible to everyone you did not hand the file to.

## Ship updates

When you make changes, rebuild with `bun run snapshot:build` and send the new `.vsix`.
Your developers reinstall it the same way; installing over an existing copy replaces
it, and the command-line form makes that explicit:

```
code --force --install-extension "path\to\new-raya-....vsix"
```

Because the build stamps a unique version each time, VS Code treats each rebuild as a
distinct version and refreshes cleanly. There is no automatic update with this method,
which is the price of staying private. If several developers end up using Raya daily
and re-sending files becomes a chore, the clean upgrade is a small private extension
registry (an Open VSX-compatible server your team points their editor at), so updates
flow automatically without going public. That is infrastructure to stand up, so it is
only worth it once the team is larger.

## Publishing publicly, and whether it is free

Yes, publishing is free. Neither of the public stores charges to host an extension.

There are two stores because "VS Code" is not one thing. Standard Microsoft VS Code
searches the Visual Studio Marketplace, while Cursor, VSCodium, and similar editors
search Open VSX. To be findable in both worlds you would publish to both, and both are
free.

For the Visual Studio Marketplace you create a free publisher through a Microsoft
Azure DevOps account, generate a personal access token, and publish with the `vsce`
tool. Open VSX works similarly with its own free account and the `ovsx` tool. In both
cases the listing is world-visible the moment it goes live: anyone can search for it,
read its description, and install it. There is no official private or org-only listing
on the Microsoft Marketplace; public means public.

Two things are worth weighing before you do that. Raya is a fork of Kilo Code, which
is MIT-licensed, so publishing a derivative is allowed, but you would be putting
Eden's private IDE, its name, and its logo on a public store for anyone to download,
which is a branding and disclosure decision more than a technical one. And the
publisher identity `eden` would need to be registered and verified on whichever store
you choose.

## Recommendation

For a tool named after Eden and meant for your team, keep it as a shared `.vsix`. Your
developers get it, nobody else can discover it, and you are not publishing an internal
IDE to the public. Reach for a private registry only when automatic updates for a
growing team become worth the setup, and reach for the public marketplaces only if you
actually want Raya to be a public product.
