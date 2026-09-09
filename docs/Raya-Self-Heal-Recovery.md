# Raya self-heal source admission and recovery

This records the source admission boundary and the subsequent durable repair-start ownership increment in OVR-09. A self-heal report is captured even when Raya source is unavailable, while repair requires an identified Raya Git checkout. It does not complete OVR-09.

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

- The durable repair-start increment below now prevents duplicate starts through this admission flow. Automatic takeover, resumable execution, and reconciliation with older clients remain unimplemented.
- Admitted repair uses the configured checkout. Dedicated worktree or branch isolation and cleanup are not implemented here.
- External changes after the final admission check remain possible. Admission does not hold a filesystem or repository lock for subsequent repair execution.
- Session creation, goal creation, intake update, and prompt dispatch remain separate operations. Startup phases and uncertainty are now retained; automated recovery and the complete repair/completion state machine require a further increment.
- Independent verification, evidence-backed completion, and release or installation authority are not established by source admission.

If admission is refused, configure an accessible committed Raya checkout in `raya.selfHeal.sourcePath`, resolve any concurrent repository operation, and retry the report. The existing captured item remains readable in the global backlog. Retry now observes an existing repair reservation and does not launch another repair. It does not resume or replay an uncertain attempt.


## Durable repair-start ownership increment

Concurrent intake now uses an exclusive SHA-256 key for the normalized report and a canonical item pointer. Independent report receipts preserve counts without a competing read/overwrite increment. The canonical record contains only its pointer and count baseline. Pending seed records allow an interrupted first publication to be completed safely; seed copies are removed after complete item publication. Terminal recurrence advances to another generation only when no actual repair reservation remains. Generic cancellation or verification of an item does not prove a repair process stopped, and cannot free that reservation. Conflicting legacy active items or existing work-session linkage return a readable `legacy_conflict` without launching a repair.

Repair admission publishes one exclusive complete claim through the existing Storage publication primitive. The winning response includes a random owner token; persistence stores its digest, and normal reads never return the token. Subsequent transitions require that owner and the exact current revision. Each revision is a new exclusive immutable record, so separate Storage instances cannot both advance the same phase. There is no expiry, blind takeover, or automatic replay.

The startup sequence is `reserved ? session_creating ? session_created ? goal_creating ? goal_created ? dispatching ? submitted`. Each creating/dispatching phase is acknowledged before its side effect is requested. The session ID is recorded at `session_created` and cannot change thereafter. Session metadata also stores the attempt ID for reconciliation if session creation succeeds but its response is lost. `submitted` records dispatch acceptance, not repair completion or verified correctness.

A pre-dispatch failure records `blocked`, including the previous phase in its sanitized reason. A dispatch failure records `dispatch_unknown`: the request may have started, so it must not be replayed automatically. If persisting the failure also fails, the last durable phase remains and the UI reports that uncertainty. Loss of a phase acknowledgement never authorizes the next side effect. Known session identity is included in the immediate notice even if recording it failed; an unknown session identity must be reconciled using attempt metadata, not guessed.

The extension lists the retained repair phase, session, and recovery reason in the global backlog. `/self-heal inspect <itemID>` reads the journal directly, including when the ordinary intake item is missing. Failure notices retain the item identifier and show the exact inspect command. The journal GET endpoint is independent of intake retention; a missing response or connection failure is not treated as proof that ownership was released. Duplicate admission produces a notice about the existing attempt and makes no additional session, goal, or prompt request. Source is revalidated again after admission, immediately before requesting session creation.

### Limits of this increment

- This is durable admission and observation, not a renewable execution lease. A lost owner token or stopped client leaves a reservation requiring explicit future reconciliation; restarting does not reclaim it.
- Existing old clients that bypass the new admission endpoints are not fenced from calling ordinary session/goal APIs. Conflicting legacy linkage is detected when present in the backlog; this is not a global repair-process supervisor.
- Generic backlog status/evidence updates retain their existing authority model. This does not implement independent verification, guarded final completion, or proof that a cancelled repair stopped.
- No isolated worktree, source lock, session cleanup transaction, dispatch idempotency, or automatic resume is provided. The existing source admission constraints still apply.
- Claim journals, canonical pointers, report receipts, and closure tombstones remain on disk for reconciliation. They need a future ownership-aware compaction policy. Full reports with retained repair attempts remain readable beyond ordinary terminal retention.
- The publication primitive syncs complete files and uses exclusive links/atomic replacement. Restart visibility and independent-instance contention are tested; machine power-loss durability and every filesystem implementation are not certified.


### Windows concurrency finding

A final contention test caught `EPERM` when independent writers replaced the same canonical pointer through concurrent Windows renames. This was an implementation defect, not dismissed as a flaky test. Canonical pointers now use exclusive immutable publication with separate pending seed records, so contenders never replace the pointer. The revised independent-Storage test passed. Readers also ignore all hidden publication path components, including nested temporary directories, so incomplete publisher artifacts cannot be mistaken for backlog rows or report receipts.


### Final ownership verification

| Command | Result |
|---|---|
| `bun test ./test/kilocode/self-heal-ownership.test.ts ./test/kilocode/self-heal.test.ts` from `packages/opencode` | 11 passed, 77 assertions, 15.02s; `.tmp/self-heal-ownership-tests.log` |
| `bun test tests/unit/self-heal-source.test.ts tests/unit/self-heal.test.ts` from `packages/kilo-vscode` | 16 passed, 106 assertions; `.tmp/self-heal-repair-client-tests.log` |
| Scoped extension ESLint for intake, summary, shared self-heal, KiloProvider, and focused tests | Exit 0; `.tmp/self-heal-repair-lint.log` |
| Scoped backend Oxlint for self-heal, its ownership test, and self-heal HTTP group/handler files | Exit 0, 13 warnings and no errors; `.tmp/self-heal-backend-lint.log` |

The backend tests create independent Storage layers pointing at actual temporary directories; eight contenders converge on one item and only one repair/stage owner. Reopening verifies retained phase and session identity. Tests cover every pre-dispatch crash boundary, wrong/stale owner rejection, unknown dispatch, legacy conflicts, terminal recurrence, generic cancellation retaining reservation, direct journal reads after intake removal, retention removal between enumeration and read, and receipt-derived backlog ordering. The list race uses real Storage enumeration/removal with controlled scheduling, not fabricated records or duplicated implementation logic.

Client tests use the generated SDK and real temporary Git checkouts. They verify successful ordered startup, duplicate refusal, each failing side effect, unavailable failure reporting, lost phase acknowledgements, source identity and revalidation, journal inspection, and safe not-found handling. No startup error text exposes raw backend payloads, and no uncertain side effect is replayed.

A concurrent full-check run exceeded existing test deadlines and subsequent cleanup raced list reads. The production list path now tolerates a concurrently removed row. The final backend run passed in a quiet slot using unchanged deadlines; deadlines were not inflated. Combined CLI/extension types and guards are owned by the integration checkpoint, including the final small list fix. SDK generation includes the direct journal endpoint. No build, installation, deployment, or repair execution against a real user project was performed.
