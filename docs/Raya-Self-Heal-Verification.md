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

## Configuration during owned repair startup

Loading configuration for a retained managed repair preserves project config reads without performing optional setup writes. The loader checks the authoritative repair journal for the matching attempt and canonical managed directory before suppressing generated `.gitignore` files, on-disk `$schema` annotations, and automatic local-plugin dependency installation. Parsed configuration still receives its schema metadata in memory, and local plugin declarations remain visible. A plugin that needs installation must be handled through an explicit setup action; this does not claim that dependencies are present or that plugin execution is confined.

Ordinary directories retain their existing setup behavior. Only UUID-shaped repair-directory candidates require journal inspection. If that inspection fails, optional writes are deferred with a diagnostic while configuration reads continue; interruption still propagates. This suppression grants no execution permission or ownership. The existing checkout verification remains strict about tracked and untracked source changes.

Actual-source attempt `e214362b-e075-4038-8848-3f36f42f4f97`, pinned to `f16aca1dc1a65363003f05d89fcc0ae6e3bceaa5`, passed full capture with digest `c25c06970f82fffe249fdd909de4bbdad1c6920e6eec1d47ca4728d9cc122268` and then correctly blocked before dispatch because config startup generated `.kilo/.gitignore` and `.kilocode/.gitignore`. That attempt remains retained and blocked; it has no executed check or artifact receipt. A fresh committed source including this fix is required for the next acceptance attempt.

## Captured source and shell deadline acceptance

The retained `35174bdf95c02ed651a700d5fdc5dec729e2d241` verification invocation captured 10,325 files. Its source digest is `1b666933beb0dec7387d2f0fc9c78d0a06cb68abaed5fab3216626fac3a21467`; `7394ebf930fdfb945559f7f2a09506337270ba71bbd6102a0d2b4faf1a546662` is the hash of the serialized manifest file, not the source digest. The snapshot, preparation, and failed terminal receipts remain retained. Dependency setup ran, but no verification test command was dispatched and no successful check, completed goal, or artifact receipt was issued.

The setup failure exposed a shell deadline defect: two polling intervals without new output could terminate a command early, and output matching diagnostic phrases could also trigger termination. Both were reported as exceeding the full requested timeout. The retained setup lasted about 54 seconds despite requesting 600,000 milliseconds. Shell execution now races process completion, explicit cancellation, and the configured deadline directly. Quiet installation phases and diagnostic text do not prove a hung or finished process. Hosted timeout caps and cancellation still apply; an actually hung command can now run until that configured deadline. Coverage uses real children that remain quiet or print diagnostic text before completing after 35 seconds, alongside existing timeout-cap coverage.

The failed invocation cannot be replayed. Any subsequent attempt must use a fresh invocation identity and retain its own source/check evidence; retained partial dependencies or manifests are not a successful test result.
