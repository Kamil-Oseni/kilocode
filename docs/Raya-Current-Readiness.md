# Raya current readiness

Snapshot: 2026-10-06. Estimated everyday readiness: **48/100**. Full installed workflow acceptance: **2 of 9**. These are separate measures; the estimate is not a percentage of passing tests.

The tracker records **23 verified, 35 in progress, 3 planned, 1 maintenance item and 1 deferred item**. The active unfinished queue has **38 requirements**. The classifications below are copied from the implementation tracker; they do not independently recertify its historical evidence against the current installed build.

The current installed build is `7.4.23-snapshot+7149fad1a5.local.1791260709819`. Independent installed verification matches all 479 non-manifest payload files, the expected three installer metadata fields and the extra VS Code manifest, with exactly 481 installed files. The full pre/post comparison preserves all 1,752 profile files, 19,400 unrelated extension files and unrelated registration rows. The original pre-scan, installer, post-scan and monitor processes and streams joined with exit 0. Evidence: `.tmp/new-pc/7149-installed-payload-independent.json` and `.tmp/new-pc/7149-install-preservation-independent.json`. Current loaded identity and its full workflows are still pending; bounded rollback retention is verified below. The current 7149 private General trial also failed: it used an incorrect input path, attempted a write denied by the task permissions, then waited on an unwanted question. An ordinary authenticated abort was accepted; the original launcher, trial, server and guardian joined without force. The terminal error was `MessageAbortedError`, and no required `result.txt` was present. Independent verification matched nine pinned job/log/build/audit references; evidence is saved in `.tmp/new-pc/general-7149-terminal-independent.json` and the earlier live tool snapshot. This is a failed task followed by orderly shutdown, not successful autonomous completion or recovery. The final frozen question-permission merge fix is independently source-reviewed: all 29 source/preimage/diff/log references match, and the runtime delta inserts user rules after Auto defaults while retaining the final Home Assistant guard and later per-agent overrides. Genuine Agent/Question tests cover allowed and denied publication (13 tests, 58 assertions), with two Home Assistant boundary tests (8 assertions). Final typecheck, lint and formatting are reported passing; this review did not independently join their historical process handles. Evidence: `.tmp/new-pc/auto-user-permission-final-source-independent.json`. Commit `c16f8c7f7523d076650bb27ee48ed8cf266095e7` matches all three reviewed frozen source files; evidence is saved in `.tmp/new-pc/auto-user-permission-commit-independent.json`. Matching build, installed workflow and the separate path failure remain pending. The preceding 57ba General workflow failed: it wrote the read tool's display decorations into the output, detected the mismatch, then failed to recover using the existing worker. Its private processes shut down normally.

A committed-source review confirms that 7149 already includes the real working directory and Windows advice against inventing `/workspace`. The task handoff separately inserts the parent model’s `brief.context`, where the false path first appeared in persisted tool arguments. The exact failed outgoing request was not captured, so actual environment delivery to that inference is unproven. Further verification must cover the parent/child request and conflicting delegation context while retaining exact path and permission semantics. Evidence: `.tmp/new-pc/general-7149-context-source-independent.json`. The new frozen worker-directory repair has now been independently source-reviewed: all 23 source/preimage/diff/log references match; the helper captures the actual directory inside the worker runtime scope and labels model context separately without rewriting absolute paths or permission rules. Actual TaskTool tests cover conflicting context and a reserved edit worktree. The full task suite reports 55 passes and 390 assertions, with the test process closure independently observed through a held handle; original check receipts remain producer evidence. Evidence: `.tmp/new-pc/worker-directory-final-frozen-independent.json`. Commit `a7cfb37f0d` matches all four reviewed frozen files. The corrected 21-source build preparation includes the new environment helper, and every source pin matches current committed HEAD `58ab585cd3`; evidence is saved in `.tmp/new-pc/worker-directory-21-source-commit-independent.json`. Actual build jobs, installation and autonomous model behavior remain pending.

The file-tool guidance fix is committed as `28ad4efd50` and passes 19 focused tests with 221 assertions, including the actual runtime tool factory and native/OAuth/envelope request preparation. The earlier factory-coverage gap is closed; an independent review is saved in `.tmp/new-pc/file-guidance-actual-factory-independent-review.json`. It is now included in the installed candidate but is not yet proven by the required autonomous workflow. The normal client restored an unsent draft and its saved model choices after ordinary close and reopen; that partial check does not certify the full General or postboot gate.

The next candidate, `7.4.23-snapshot+7149fad1a5.local.1791260709819`, has completed the supported CLI and extension builds. Independent verification confirms both original build processes and streams joined with exit 0, all 17 explicit source inputs per build match commit `7149fad1a556f9c068bbaae9c6ccc8f4777712da`, and the 482-entry VSIX passes its full CRC check. The archive is 190,469,724 bytes with SHA-256 `dd116902688ba5a74e9e36dabc59b1df070dd38a0abceb699d7cac26488c2eec`. Evidence: `.tmp/new-pc/post-filetools-build-terminal-independent.json`. The subsequent independent full payload audit compared all 482 entries and 640,636,877 uncompressed bytes against the actual processed VSCE manifest, with exact sizes and SHA-256 hashes. All 17 explicit build source inputs are present in the admitted collector configuration; the original collector and streams joined normally. Evidence: `.tmp/new-pc/current-7149-full-payload-independent.json`. Installation and preservation are now independently verified; required workflows remain pending. The recovery request regression is committed as `51b2ba2af2`; its real tool-factory/request preparation check does not establish autonomous model recovery.

Home Assistant now has a fresh manual backup, `c1dce02b`, created October 6 at 12:31 a.m. after the ceiling-off Sleep fade change. A stable PC-side copy is saved at `D:/RayaBackups/HomeAssistant/sleep-ceiling-off-c1dce02b-20261006.tar` (12,840,960 bytes, SHA-256 `a345aeaf3e4b1f126aa684b9ce2148833f5e70b5e3be692bbfeb60064c181511`). The outer archive and all three inner archives were read fully, and the updated sleep script is present. Home Assistant retains its encrypted copy; the downloaded export is readable and should remain in the recovery folder. The browser download event timed out, so completion was not inferred from that event. Evidence: `.tmp/new-pc/sleep-fade-backup-local-integrity-20261006.json`. No live restore was performed.

The current normal-profile Home Assistant adapter still maps `sleep_mode` to the old `scene.sleep_mode`, as verified through a read-only query of the saved extension settings. The dashboard’s updated manual action instead uses `script.sleep_mode_fade`. Updating the adapter start/stop mappings through its supported settings owner remains pending; credentials, other modes and light selections must be preserved, and the active fade must not be restarted for this configuration check. Evidence: `.tmp/new-pc/sleep-adapter-mapping-readonly-20261006.json`.

Bounded rollback retention is now independently verified. Production `PackageVault` keeps eight indexed packages: the oldest snapshot was rotated out, the remaining seven entries are unchanged, and the current 7149 package is retained and active. All eight live archives match their indexed sizes and hashes; the active archive’s embedded CLI also matches. The original rotation process and streams joined with exit 0 without force. All eight prior archives and the byte-exact original index are preserved in `D:/RayaBackups/PackageVault-20261006-before-7149-exact`. Earlier independently verified archive copies remain in `D:/RayaBackups/PackageVault-20261006-before-7149`; its reformatted index is a logical record, not a byte-exact source copy. Evidence: `.tmp/new-pc/7149-bounded-vault-post-independent.json`. This closes retention reconciliation, not live restore, loaded-client identity, reinstall or postboot acceptance.

Keep conversation, voice, routines, jobs, organizations, goals, coding, memory, activity and recovery in scope. Automatic SecondBrain capture remains off. Decision-model evaluation, video inference, PersonaPlex testing and second-PC migration remain deferred or cancelled.

Use [the full implementation tracker](Raya-Implementation-Progress.md#findings-and-overhauls) and [the PC setup checklist](Raya-New-PC-Setup.md) for the detailed requirements. Earlier scores and source-only successes do not override this snapshot.

## Installed workflow gates

These nine gates come from `docs/Raya-Local-Readiness-Gates.md`. Their scope is retained across candidate updates. The installed package and preservation checks above cover the first two gates for the current build. Source tests and isolated installed-CLI fixtures do not establish normal-client persistence, physical voice quality, configured personal Memory or recovery after a real Windows boot.

| Gate | Current status | Required evidence |
|---|---|---|
| Audited combined candidate | Passed | Actual installed files and manifest match the reviewed current package. |
| Normal installation preservation | Passed | Saved profile and unrelated extension contents and registration survive the upgrade; original installer and streams join. |
| Installed local General/tool turn | Pending | Finish the permitted task with actual tool evidence, then preserve the reply, selected model and draft through ordinary close and reopen. The current worker test additionally retains one worker, actual write/readback and autonomous goal completion. |
| Strict installed Coder | Pending | Complete the exact permitted edit/test task without extra shell calls or final text, and retain the required saved evidence. |
| Installed Voice and permitted Home Assistant flow | Pending | Fresh-session and repeated capture work without duplicate or stale drafts; later typed drafts survive; Stop, pause and error recovery work; a permitted action is verified and the reply is audibly continuous. |
| Scheduled routines | Pending | Two genuine scheduled work periods produce the required evidence; pause/stop and cold no-replay pass. |
| Configured Memory | Pending | Genuine configured sync/search and worker shutdown pass, including pause, ordinary joins and durable debt; automatic personal capture stays off. |
| Matching-version postboot/service recovery | Pending | After a real Windows boot, preserve saved selections, chats and drafts, reconnect intended services and avoid unsolicited worker replay. |
| Populated same-candidate reinstall recovery | Pending | Reinstall the same candidate with populated state, then verify cold restoration and no replay; upgrade preservation alone does not satisfy this gate. |

## Active unfinished requirements

| Requirement | Recorded status |
|---|---|
| PR-01 — Establish an outcome-led default experience | In progress |
| PR-04 — Define a routine's authority in capabilities, not its persona | In progress |
| PR-05 — Make spending understandable and bounded where needed | In progress |
| EN-02 — Give routines atomic execution ownership and restart semantics | In progress |
| EN-05 — Identify reviewed content by revision, not line positions | In progress |
| EN-10 — Specify the supported local-service security topology | In progress |
| EN-12 — Make media failures observable and session ownership atomic | In progress |
| EN-15 — Make release confidence reproducible across the fork | In progress |
| UI-02 — Establish measurable accessibility gates | In progress |
| 11.1 OVR-01 - OpenAI native realtime multimodal voice | In progress |
| 11.2 OVR-02 — A first-class browser skill for agents | In progress |
| 11.3 OVR-03 - Smarter Auto routing and orchestration | In progress |
| 11.4 OVR-04 - Calculated, explainable token and tool costs | In progress |
| 11.5 OVR-05 — A durable, understandable routine system | In progress |
| 11.6 OVR-06 — An outcome-driven Goal system | In progress |
| 11.7 OVR-07 — Complete Raya UI and UX redesign | In progress |
| 11.8 OVR-08 — Broad work tools with discoverable capabilities | In progress |
| 11.9 OVR-09 — Self-heal as verified recovery and repair | In progress |
| 11.10 OVR-10 — Browser runtime and product overhaul | In progress |
| FUT-CU-01 — Autonomous Desktop Mode | In progress |
| FUT-VIS-01 - Live multimodal desktop and mobile vision | In progress |
| FUT-AGENT-01 — Intelligent spawning and durable delegated-agent names | In progress |
| FUT-AGENT-02 — Visible and accessible active subagents | In progress |
| FUT-CONTACT-01 — Agent contact by Raya, email, Telegram and WhatsApp | In progress |
| FUT-ORG-01 — Durable organizations that execute company work | In progress |
| FUT-RMSG-01 — Messenger-grade Routine conversations | In progress |
| FUT-RCHAT-01 — Create routines and organizations from main chat | In progress |
| FUT-PERSIST-01 — Restart/rebuild survival for agents and routines | In progress |
| FUT-TODO-01 — Personal intelligent Todo and focus timer | In progress |
| FUT-CLOUD-01 — Cloud session storage and remote continuation | Planned |
| FUT-CONNECT-01 — Personal app connector platform | Planned |
| FUT-GUI-01 — Generative interactive UI | Planned |
| FUT-ARCH-01 — Authoritative task events and UI projection | In progress |
| FUT-ARCH-02 — Explicit thread and owned-worker lifecycle | In progress |
| FUT-ARCH-03 — Bounded queues, backpressure and shutdown | In progress |
| FUT-ARCH-04 — Last-moment execution authority | In progress |
| FUT-DATA-01 — Durable personal profile and portable recovery | In progress |
| FUT-LOCAL-01 — Validated local models and shared inference | In progress |

## Requirements recorded as verified

| Requirement | Recorded status |
|---|---|
| PR-02 — Make completion an inspectable agreement | Verified |
| PR-03 — Make routine scheduling explicit before activation | Verified |
| PR-06 — Publish a supported-client and feature matrix | Verified |
| EN-01 — Gate destructive session migration on an explicit upgrade policy | Verified |
| EN-03 — Implement timezone and event-filter semantics end to end | Verified |
| EN-04 — Acknowledge review actions before dismissing them | Verified |
| EN-06 — Preserve the last working canvas across failed updates and restarts | Verified |
| EN-07 — Use explicit compatibility contracts during the runtime migration | Verified |
| EN-08 — Repair schema regression checks and isolate contract-test state | Verified |
| EN-09 — Harden the update path and credential storage | Verified |
| EN-11 — Give browser identity and captured authentication a lifecycle | Verified |
| EN-13 — Treat recordings and telemetry as separate data products | Verified |
| EN-14 — Measure recovery and streaming performance across client boundaries | Verified |
| UX-01 — Match review labels to action scope | Verified |
| UX-02 — Present progress as current work and next decision | Verified |
| UX-03 — Use a consistent interruption and recovery vocabulary | Verified |
| UX-04 — Expose context provenance and control where work happens | Verified |
| UX-05 — Make history a route back to work, not just a list | Verified |
| UI-01 — Test real components in the visual harness | Verified |
| UI-03 — Consolidate component semantics while preserving host-specific styling | Verified |
| FUT-CHAT-01 — Truthful time in chat | Verified |
| FUT-SKILL-01 — Universal role skills for every agent | Verified |
| FUT-ADM-01 — Raya admin health and logs | Verified |

## Maintenance and deferred work

| Requirement | Recorded status |
|---|---|
| FUT-BRAND-01 — Raya public identity and compatibility-first Kilo migration | Maintenance priority |
| FUT-EDITOR-01 — Raya-owned VS Code distribution | Deferred — Version 3 |

## Snapshot provenance

Source: integration-worktree `docs/Raya-Implementation-Progress.md`, SHA256 `e1216e4a41c39c1af718a61699f4da03d30664f527cd42d6fbc68afc12a1f217`. All 63 requirement IDs and statuses were extracted once from the same byte snapshot; none were dropped or promoted. Corrupted dash characters in display labels were normalized for readability; requirement IDs and status meanings are unchanged. The snapshot must be refreshed after a verified status change.

<details>
<summary>Historical build, test and failure evidence</summary>

The matching repairs are installed; complete workflow verification remains pending. The event-wakeup helper compiled and passed all eight native regression cases: normal and capture modes each retained complete positive families up to 3,073 processes with zero missed opens; both overflow cases correctly refused completeness at the 4,096-record limit. Saved original child births, exit codes and process/stream joins were independently checked. These fixture results do not establish normal installed General or routine acceptance. The earlier run that missed five processes remains preserved. The revised large positive case stays below the supported process cap and retains Windows console helpers. Worker-assignment, admission cleanup and routing-refusal repairs also pass source checks but still require matching installed workflow verification.

Keep routines, jobs, organizations, goals, coding, voice, memory, activity and recovery in scope. Automatic SecondBrain capture remains off. Decision-model evaluation, video inference, PersonaPlex testing and second-PC migration remain deferred or cancelled under the existing instructions.

The matching update package is now built: `7.4.23-snapshot+ddccef1e67.local.1791249931251`. Independent verification streamed all 482 archive entries, checked the packaged CLI and native files against their final build outputs, recomputed the native source fingerprint, and matched the executable's debug identifier with its PDB. The Memory adapter retains compatibility with the exact previous helper recipe and accepts the reviewed new recipe. Packaging rebuilt the native executable, so installation checks must use the final archive's hashes rather than the earlier CLI-stage native hashes. The monitored installation has now finished naturally. The before/after audit reports identical profile contents, unrelated extension payloads and unrelated registry entries. An additional independent installed check matches all 479 payload files and the package manifest, allowing only VS Code installation metadata; the extra `.vsixmanifest` exactly matches the archive manifest. Evidence is saved in `.tmp/new-pc/ddccef-installed-independent-current.json`. This proves installed file integrity, with per-file stable hashes rather than an atomic directory snapshot. Loaded UI/backend and full runtime acceptance remain separate; readiness and passing workflow counts are unchanged.

Use [the full implementation tracker](Raya-Implementation-Progress.md#findings-and-overhauls) for evidence and remaining acceptance conditions, and [the PC setup checklist](Raya-New-PC-Setup.md) for local integration details. Historical readiness scores in the full tracker do not override this snapshot.

The first installed General run remains a failed gate. Its original controller exited with code 1 and joined its streams without forced termination; the server and guardian retired naturally. The isolated fixture reports `ContextOverflowError`: compaction still exceeded the model limit after three attempts. Its stream also records six distinct General child sessions where the acceptance condition requires one delegated worker. Successful inference steps alone do not satisfy that condition. Investigate continuation context and worker reuse before another unchanged run; neither preserved files nor successful shutdown promotes the full workflow to accepted.

The context-counter repair is committed as `f503182e6f`: completed usable inference resets the consecutive ineffective-compaction count. Eight source regression tests with 46 assertions pass, including four compaction cycles separated by actual reads and exhaustion after three ineffective attempts. Summaries, synthetic text and failed or incomplete tools do not reset the count. Worker recovery is committed as `3dbb48122c`; its focused regression passes 420 assertions, and the current task suite passes 62 tests with 410 assertions. The repair retains the authenticated worker through synthesis and failed resumes, checks publication races, and preserves separate later goal dispatches. These are source checks; neither repair is yet accepted in the installed General workflow.

The replacement package built from `4725036b5c` is `7.4.23-snapshot+4725036b5c.local.1791254387731`. Its original build process exited successfully and joined its streams without forced termination. Independent inspection checked all 482 archive entries, matched all 50 bundled binary files to the build, and matched the native executable's CodeView identity to its PDB. The archive SHA256 is `bd8113ecf3d43f65df18559c8914bad773d9316736eb08629cd409af6b3c6aa6`; the complete independent manifest is `.tmp/new-pc/4725-independent-archive-integrity.json`. The replacement is now installed. Independent installed inspection matches all 479 payload files and the extra VS Code manifest to the archive, with only the expected installer metadata in package.json. The original installer and monitor exited naturally. Profile and unrelated extension files match the preservation baseline, but the first preservation check failed because VS Code added a UUID to the unrelated openai.chatgpt registration. The exact delta is confined to that UUID; the failed result is retained. A fresh same-version reinstall passed an independent comparison of 1,720 profile files, 19,400 unrelated extension files and all unrelated registry rows. All four original installer/scanner/monitor processes exited successfully and joined their streams without forced termination. The rollback vault now contains the new package plus all six unchanged prior packages, with all seven archive hashes independently checked.

The integration chat refreshed the normal loaded UI and recorded the matching extension and connected backend versions. Independent inspection confirms that the live backend PID, executable path and on-disk digest match the installed package. This proves loaded identity and health reporting, not the complete General, routine, voice or restart workflows. The runtime test setup now selects the 50 root binary companions correctly, excluding 18 nested dependency files previously selected by mistake. The full General and routine workflows remain pending; readiness and passing workflow counts are unchanged.

The replacement installed General run has also failed its autonomous acceptance condition. A read-only live database inspection shows exactly one child and one completed child tool: reading input.txt. The child twice claims that result.txt was written and verified, but there is no mutation or output-readback tool and the output file is absent. The goal completion guard correctly refuses the unsupported evidence. The parent then accumulates seven worker-reuse errors and publishes a question instead of finishing. The integration chat subsequently aborted the private session through its authenticated API. Independent verification confirms the original launcher exited with code 1 and joined its process and streams without forced termination; the backend and native guardian exited with code 0. The normal installed backend remains live. This clean failure retirement does not promote the workflow to accepted; closure evidence is saved in `.tmp/new-pc/general-4725-failed-closure-independent.json`. Independent evidence is saved in `.tmp/new-pc/general-4725-live-false-mutation-independent.json`. Retain the one-worker, exact-byte, actual-write/readback and autonomous completion criteria for the fix and retest.

Two follow-up repairs are committed in the integration worktree: `37f860b159` checks question and option permissions before publication, including low-confidence routing; `57ba592fad` advertises the authenticated existing worker and requires a concrete correction objective after a rejected completion audit. The tool description now carries recovery instructions as well as the input schema. Current source tests pass 12 question/routing cases with 55 assertions and 19 recovery/request cases with 612 assertions; the combined CLI typecheck passes. The recovery test exercises the production request preparer and completion envelope, while factory wiring is source-reviewed. These repairs still require the unchanged full installed workflow test; readiness remains 48/100 and installed acceptance remains 2/9. Automatic Memory capture stays off.

That replacement package has now built: `7.4.23-snapshot+57ba592fad.local.1791257813927`. Independent inspection streamed every archive entry and matched all 482 sizes and digests to the processed packaging manifest. Parsing the actual native executable's PE debug directory and the PDB information stream confirms the same debug GUID and age; the metadata names their exact digests and the reviewed recipe. The archive SHA256 is `9fff04a3fe8b12c2d7cf72740d4cddfd3160aad203310c525f563388826dc9ef`. Evidence is saved in `.tmp/new-pc/57ba-independent-archive-integrity.json`. The package is now installed. An independent check matches all 479 non-package.json payload files, the package manifest apart from its three expected installer fields, and the extra VS Code manifest. Repeated inventories contain exactly 481 files. The CLI and native helper have actual x64 PE headers; VS Code's platform metadata remains the literal undefined, as in the previous installation, and is not used as platform evidence. Independent comparison of the recorded pre/post snapshots matches all 1,731 profile files, 19,400 unrelated extension files and every unrelated registry row. The original installer, post-snapshot scanner and monitor exited successfully and joined their process and streams without forced termination. The monitor observed only the sole installer in its samples and stopped normally; this is not kernel-event completeness. Evidence is saved in `.tmp/new-pc/57ba-installed-independent-current.json` and `.tmp/new-pc/57ba-install-preservation-closure-independent.json`. The rollback vault now contains the new active package plus all seven unchanged earlier packages; all eight archive digests and the preserved prior rows were independently checked. The live normal backend's process birth, installed path and stable on-disk CLI digest match the new package. Evidence is saved in `.tmp/new-pc/57ba-vault-retention-independent-current.json` and `.tmp/new-pc/57ba-loaded-backend-independent.json`. These checks do not establish the unchanged full workflows, so readiness and accepted gate counts remain unchanged.

The current 57ba General trial has actual mutation and readback evidence, but its output is incorrect: input.txt is 48 bytes; result.txt is 85 bytes because it includes the read tool's presentation prefix and footer. Independent inspection of the saved files and synthetic session database confirms the mismatch. The parent identifies the failed exact-byte criterion and the goal guard keeps the goal active, but two subsequent recovery task calls omit the required existing task_id and are rejected. All three original controller/helper/producer process births and installed paths were observed live; no terminal result was present at that observation. The trial subsequently finished with failure after recovery exhausted its 4,096-token output limit. Independent closure review rehashed seven original job/log references and confirmed launcher exit 1, server and guardian exit 0, ordinary process/stream joins and no forced termination; none of those original PIDs remains live. The independent receipts are `.tmp/new-pc/general-57ba-live-copy-independent.json` and `.tmp/new-pc/general-57ba-failed-closure-independent.json`. This clean shutdown does not accept the workflow. Retain autonomous repair, one worker and exact-byte verification; do not substitute a text claim or successful write for completion.

A targeted file-tool guidance fix is being prepared after the current failure. It distinguishes display decorations from actual file text, preserves literal file content resembling decorations, and requires captured byte/hash evidence rather than invented equality claims. Independent review confirms the production factory wiring in source. The corrected actual-registry request-preparation tests report 19 passes with 214 assertions across native and envelope transport; the test constructs its own aiTool descriptions, so it does not independently execute the production factory. Evidence is saved in `.tmp/new-pc/file-guidance-independent-source-review.json` and `.tmp/new-pc/file-guidance-qualified-tests-independent.json`. Installation and the unchanged autonomous exact-copy/worker-recovery test remain pending.

</details>
