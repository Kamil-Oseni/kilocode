# Repair verification against captured source

`self_heal_verify` runs a check from a retained source input snapshot belonging to the active repair goal. A source snapshot receipt is evidence about that invocation. It is not a release, installation, dependency lock, or execution-confinement guarantee.

## Invocation and recovery

Supply `command`, an optional relative `workdir`, an optional timeout up to ten minutes, and optional `setup`. The tool captures source and materializes a private checkout. It executes setup from that checkout's root, then the check from the requested directory, using the existing shell permission and execution path. Setup is explicit; no dependency installation, repository setup script, Git checkout hook, or checkout filter runs automatically.

For example, a repair may request `setup: "bun install --frozen-lockfile --ignore-scripts"`, `command: "bun test ./test/kilocode/relevant.test.ts"`, and `workdir: "packages/opencode"`. Actual dependency availability and package requirements determine whether that setup is sufficient. The empty private Git metadata supports ignore-aware inspection; it does not pretend to contain the original repository history. Checks that require that history need a supported fixture or a future history materializer.

Every invocation reserves durable intent before capture. Its snapshot, preparation dispatch, check dispatch, successful result, and failure/interruption acknowledgement are retained separately. An interrupted process can leave intent or dispatch without terminal acknowledgement; this is an unknown outcome. Reusing the same session/message/call identity never executes again. Use `self_heal_verify` with `action: "inspect"`, the original `messageID`, and `callID` to read retained stages in the owning session. Inspection never replays setup or the check. A new invocation is a new explicit execution request.

## Source contract

Capture includes raw tracked working files and nonignored untracked files, including dirty content and tracked deletions. It records the full current Git commit, relative paths, SHA-256 content, size, and executable mode. Windows uses the tracked Git index executable bit because its ordinary file mode cannot represent it reliably. Missing unsupported inputs stop capture rather than being silently omitted.

On Windows, owned preparation and snapshot Git commands enable long-path support for that invocation. This prevents deeper repair/check directories from failing checkout or omitting source paths; repository and global Git settings remain unchanged. An earlier partial preparation still remains `worktree_unknown` with its reserved branch and directory. Installing this fix does not replay or erase that attempt.

The source root must still be the owned Git checkout, its common Git directory must match the repair journal, and the admitted commit must remain an ancestor. Capture checks file identity around each read and compares two complete observations. Files and manifests are retained by content digest, and every materialized blob is revalidated. The verification copy has regular files instead of links to mutable repair source. Materialized Git LFS bytes are captured directly; unresolved pointers are rejected. No LFS program or network fetch is invoked.

Ignored dependencies and ignored credentials are not copied. Unignored credential-shaped files are rejected. `.npmrc` supports an explicit set of ordinary noncredential settings, including Raya's `enable-pre-post-scripts`; auth keys, environment interpolation, unsupported entries, and credential-bearing registry URLs require review. Other source bytes are not a general-purpose secret scanner. Submodules, symlinks, unmerged indexes, files above 256 MiB, more than 100,000 files, and source above 1 GiB require explicit support. Snapshot storage must be separate from source.

Setup and checks must preserve captured files and may not introduce new nonignored source inputs. Ignored dependency/build outputs can be created. The original repair source is checked again before dispatch, after execution, and before goal completion. Changes reject source verification rather than attaching old checks to a later checkout.

These observations establish captured input and endpoint consistency. The execution copy remains writable; transient modifications followed by restoration are not proven absent. Dependencies, inherited process environment, external services, compiler behavior, and external files accessed by commands are not sealed. Existing permission and sandbox preferences remain authoritative. This feature does not silently strengthen or weaken them, and it does not describe Windows worktree separation as process confinement.

## Goal and delivery evidence

Goal validation resolves a real persisted `self_heal_verify` tool part against its independently retained invocation receipt. Caller-provided metadata cannot manufacture that receipt. The receipt identifies the repair attempt, session/message/call, objective and criteria identity, command, snapshot, and successful exit. All source-bound checks cited for completion must describe one current source input. Each passed requirement needs source-bound evidence for the completion receipt to report full snapshot-input coverage.

Other legitimate evidence still supports the existing goal audit, but its delivery source identity remains explicitly unknown. Existing tested-completion receipts are not retroactively upgraded using today's HEAD. Human acceptance and objective revisions keep their existing goal semantics; verification does not replace intent or complete a goal itself.

## Reviewable artifact preparation

After a repair goal completes with full snapshot-input coverage, `self_heal_verify` supports `action: "build-artifact"`, explicit dependency `setup`, and an optional timeout up to one hour. It resolves the stored completion and each cited successful check itself, then materializes their retained source bytes into a new private writable checkout. It does not capture a later HEAD and label it tested. Legacy or incomplete source coverage is ineligible.

The packaging command runs through the same shell permission path. A host-created build input binds the completion digest, check IDs, snapshot digest, target platform, unique extension/CLI version, and private output path. Repair packaging uses these source identities instead of requiring original Git history. SDK generation or build scripts that change captured source fail the source contract; generated drift must be checked and completed as a new source input. The repair cache path cannot fall back to an unrelated compiled binary when validation fails.

The package embeds `dist/raya-build.json`. After a successful build, the host independently reads the actual VSIX package identity, XML identity, embedded build identity, and CLI bytes, and hashes the complete archive. It retains a `ready-for-review` artifact receipt only after these checks. This proves the recorded artifact was produced from the captured input contract; build commands can still write their checkout, and dependencies, toolchains, environment, network responses, and transient writes remain unsealed. It is not reproducible-build or execution-confinement proof.

Use `action: "inspect-artifact"` with the original message/call IDs to inspect intent, build input, dispatch, terminal acknowledgement, and any retained result. Inspection rehashes available artifact bytes and reports whether they still match the receipt. Failed setup, build failures, and interrupted or lost acknowledgements never become successful artifacts, and invocation IDs cannot replay execution. Artifact files remain in private snapshot storage for review; no publication or installation follows from this tool.

The remaining delivery stages must retain a release identity, reconcile the running installed build, replay the relevant check, and notify the reporter once. A reviewable artifact receipt does not establish any of those outcomes.
