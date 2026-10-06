# Raya current readiness

Snapshot: 2026-10-05. Estimated everyday readiness: **48/100**. Full installed workflow acceptance: **2 of 9**. These are separate measures; the estimate is not a percentage of passing tests.

The tracker records **23 verified, 35 in progress, 3 planned, 1 maintenance item and 1 deferred item**. The active unfinished queue has **38 requirements**. The classifications below are copied from the implementation tracker; they do not independently recertify its historical evidence against the current installed build.

The matching repairs are installed; complete workflow verification remains pending. The event-wakeup helper compiled and passed all eight native regression cases: normal and capture modes each retained complete positive families up to 3,073 processes with zero missed opens; both overflow cases correctly refused completeness at the 4,096-record limit. Saved original child births, exit codes and process/stream joins were independently checked. These fixture results do not establish normal installed General or routine acceptance. The earlier run that missed five processes remains preserved. The revised large positive case stays below the supported process cap and retains Windows console helpers. Worker-assignment, admission cleanup and routing-refusal repairs also pass source checks but still require matching installed workflow verification.

Keep routines, jobs, organizations, goals, coding, voice, memory, activity and recovery in scope. Automatic SecondBrain capture remains off. Decision-model evaluation, video inference, PersonaPlex testing and second-PC migration remain deferred or cancelled under the existing instructions.

The matching update package is now built: `7.4.23-snapshot+ddccef1e67.local.1791249931251`. Independent verification streamed all 482 archive entries, checked the packaged CLI and native files against their final build outputs, recomputed the native source fingerprint, and matched the executable's debug identifier with its PDB. The Memory adapter retains compatibility with the exact previous helper recipe and accepts the reviewed new recipe. Packaging rebuilt the native executable, so installation checks must use the final archive's hashes rather than the earlier CLI-stage native hashes. The monitored installation has now finished naturally. The before/after audit reports identical profile contents, unrelated extension payloads and unrelated registry entries. An additional independent installed check matches all 479 payload files and the package manifest, allowing only VS Code installation metadata; the extra `.vsixmanifest` exactly matches the archive manifest. Evidence is saved in `.tmp/new-pc/ddccef-installed-independent-current.json`. This proves installed file integrity, with per-file stable hashes rather than an atomic directory snapshot. Loaded UI/backend and full runtime acceptance remain separate; readiness and passing workflow counts are unchanged.

Use [the full implementation tracker](Raya-Implementation-Progress.md#findings-and-overhauls) for evidence and remaining acceptance conditions, and [the PC setup checklist](Raya-New-PC-Setup.md) for local integration details. Historical readiness scores in the full tracker do not override this snapshot.

The first installed General run remains a failed gate. Its original controller exited with code 1 and joined its streams without forced termination; the server and guardian retired naturally. The isolated fixture reports `ContextOverflowError`: compaction still exceeded the model limit after three attempts. Its stream also records six distinct General child sessions where the acceptance condition requires one delegated worker. Successful inference steps alone do not satisfy that condition. Investigate continuation context and worker reuse before another unchanged run; neither preserved files nor successful shutdown promotes the full workflow to accepted.

The context-counter repair is now committed as `f503182e6f`: completed usable inference resets the consecutive ineffective-compaction count. Eight source regression tests with 46 assertions pass, including four compaction cycles separated by actual reads and exhaustion after three ineffective attempts. Summaries, synthetic text and failed or incomplete tools do not reset the count. This repair is not yet in the reviewed installed package. Worker recovery remains under validation, including synthesis, failed resumes and later goal dispatches. The full installed General gate and readiness measures remain unchanged until the repaired package passes the complete workflow.

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
