# Raya self-heal source admission and recovery

This implements the missing-source admission boundary in OVR-09. A self-heal report is captured even when Raya source is unavailable, while repair requires an identified Raya Git checkout. It does not complete OVR-09.

## User behavior

Reports and backlog reads use an extension-global storage directory as their backend context. An unrelated open project is never used as a substitute repair target. With missing, invalid, stale, or changed source, the report remains in the global backlog and the user receives a setup or retry reason. No repair session, goal, status update, or prompt is created for that admission.

An explicit `raya.selfHeal.sourcePath` is authoritative and must identify the absolute Git repository root. When unset, source may be derived only from a development extension installed at `packages/kilo-vscode` inside a valid checkout. A failed explicit configuration never falls back to that development checkout.

For admitted source, the existing repair flow creates a session and linked goal in the verified checkout. Session metadata records `rayaSelfHealSource` with canonical `root` and `commit`; the initial repair prompt repeats this evidence. The intake links to the work session. The UI calls this a source-repair session; it does not claim a dedicated worktree exists.

## Admission checks

The resolver canonicalizes the path, confirms the Git top-level directory, and reads a committed HEAD revision. Both working and committed manifests must identify `@kilocode/kilo`, `@kilocode/cli`, and the `raya` extension published by `eden`. Working manifest targets must remain within the source root and be regular files within the size limit. HEAD is checked again after inspection.

Git runs without inherited `GIT_*` variables, using case-insensitive environment-key filtering to prevent Windows mixed-case variables from redirecting verification. Commands are shell-free, bounded by a timeout and output limit, and do not alter Git trust configuration. User-facing failures contain setup guidance rather than raw command output.

After asynchronous session metadata preparation, admission resolves the original configured or development path again and compares canonical root and commit. This rejects a changed HEAD, vanished source, or retargeted source junction before creating repair resources.

These checks establish committed package identity, not cryptographic trust or signed provenance. They do not certify release compatibility. The recorded revision is an admission snapshot, not an ongoing source lock.

## Verification

Commands run from `packages/kilo-vscode` unless specified otherwise:

| Command | Result |
|---|---|
| `bun test tests/unit/self-heal-source.test.ts tests/unit/self-heal.test.ts` | 10 tests passed, 67 assertions; `.tmp/self-heal-source-admission-tests.log` |
| `bun test ./test/kilocode/self-heal.test.ts` from `packages/opencode` | 4 tests passed, 22 assertions; `.tmp/self-heal-backlog-tests.log` |
| Scoped ESLint for the touched source and tests | Passed; `.tmp/self-heal-source-lint.log` |
| Prettier check for the touched source, tests, and package manifest | Passed; `.tmp/self-heal-source-format.log` |
| Scoped `git diff --check` | Passed |

The admission tests exercise real temporary Git repositories and the generated SDK against a controlled HTTP transport. They cover explicit and development roots, invalid roots, missing source with an unrelated project, committed identity mismatch, inherited Git environment redirection, revision changes during preparation, and source junction retargeting. Capture-only tests assert that no repair requests occur and unrelated files remain unchanged. Successful admission verifies request directories and persisted source metadata. The existing backend tests cover real backlog storage, sequential deduplication, updates, and retention; they do not prove concurrent repair ownership.

A read-only invocation of the actual resolver against this checkout failed under the sandbox account because Git rejected repository ownership (`CodexSandboxOffline` versus the owning user). The same invocation outside the sandbox under the actual user succeeded with canonical root `C:\Users\User\Desktop\raya` and commit `08c731d555e620085a1bfd4b4d1560564184dbb7`. No `safe.directory` or other Git configuration was changed. Evidence is in `.tmp/self-heal-current-checkout.log` and `.tmp/self-heal-current-checkout-user.log`. The successful probe verifies admission under the owning account; it is not a packaged-extension test.

The probe, run from the extension package, imports `resolve` from `./src/self-heal/source`, calls it with `{ configured: path.resolve("../.."), extension: "" }`, prints the result, and returns a failing exit status if admission fails.

Combined extension typechecking and repository guards are coordinated by the integration agent and recorded in its checkpoint. No package build, installation, deployment, or full extension runtime test was performed for this increment.

## Remaining recovery and authority work

- Concurrent duplicate intake can still start competing repairs. Sequential backlog deduplication is not a repair lease. Durable ownership, attempt identity, and restart recovery remain necessary.
- Admitted repair uses the configured checkout. Dedicated worktree or branch isolation and cleanup are not implemented here.
- External changes after the final admission check remain possible. Admission does not hold a filesystem or repository lock for subsequent repair execution.
- Session creation, goal creation, intake update, and prompt dispatch remain separate operations. Partial-failure recovery and guarded legal state transitions require a further increment.
- Independent verification, evidence-backed completion, and release or installation authority are not established by source admission.

If admission is refused, configure an accessible committed Raya checkout in `raya.selfHeal.sourcePath`, resolve any concurrent repository operation, and retry the report. The existing captured item remains readable in the global backlog. Retry is not yet an ownership-safe resume operation, so the duplicate-repair limitation remains open.
