# Raya current readiness

Snapshot: 2026-10-05. Estimated everyday readiness: **48/100**. Full installed workflow acceptance: **2 of 9**. These are separate measures; the estimate is not a percentage of passing tests.

The tracker records **23 verified, 35 in progress, 3 planned, 1 maintenance item and 1 deferred item**. The active unfinished queue has **38 requirements**. The classifications below are copied from the implementation tracker; they do not independently recertify its historical evidence against the current installed build.

The current blocker is installing the matching repairs and verifying complete workflows. The event-wakeup helper compiled and passed all eight native regression cases: normal and capture modes each retained complete positive families up to 3,073 processes with zero missed opens; both overflow cases correctly refused completeness at the 4,096-record limit. Saved original child births, exit codes and process/stream joins were independently checked. These fixture results do not establish normal installed General or routine acceptance. The earlier run that missed five processes remains preserved. The revised large positive case stays below the supported process cap and retains Windows console helpers. Worker-assignment, admission cleanup and routing-refusal repairs also pass source checks but still require matching installed workflow verification.

Keep routines, jobs, organizations, goals, coding, voice, memory, activity and recovery in scope. Automatic SecondBrain capture remains off. Decision-model evaluation, video inference, PersonaPlex testing and second-PC migration remain deferred or cancelled under the existing instructions.

Use [the full implementation tracker](Raya-Implementation-Progress.md#findings-and-overhauls) for evidence and remaining acceptance conditions, and [the PC setup checklist](Raya-New-PC-Setup.md) for local integration details. Historical readiness scores in the full tracker do not override this snapshot.

## Active unfinished requirements

| Requirement | Recorded status |
|---|---|
| PR-01 â€” Establish an outcome-led default experience | In progress |
| PR-04 â€” Define a routine's authority in capabilities, not its persona | In progress |
| PR-05 â€” Make spending understandable and bounded where needed | In progress |
| EN-02 — Give routines atomic execution ownership and restart semantics | In progress |
| EN-05 — Identify reviewed content by revision, not line positions | In progress |
| EN-10 â€” Specify the supported local-service security topology | In progress |
| EN-12 â€” Make media failures observable and session ownership atomic | In progress |
| EN-15 â€” Make release confidence reproducible across the fork | In progress |
| UI-02 â€” Establish measurable accessibility gates | In progress |
| 11.1 OVR-01 - OpenAI native realtime multimodal voice | In progress |
| 11.2 OVR-02 â€” A first-class browser skill for agents | In progress |
| 11.3 OVR-03 - Smarter Auto routing and orchestration | In progress |
| 11.4 OVR-04 - Calculated, explainable token and tool costs | In progress |
| 11.5 OVR-05 â€” A durable, understandable routine system | In progress |
| 11.6 OVR-06 â€” An outcome-driven Goal system | In progress |
| 11.7 OVR-07 â€” Complete Raya UI and UX redesign | In progress |
| 11.8 OVR-08 â€” Broad work tools with discoverable capabilities | In progress |
| 11.9 OVR-09 â€” Self-heal as verified recovery and repair | In progress |
| 11.10 OVR-10 â€” Browser runtime and product overhaul | In progress |
| FUT-CU-01 — Autonomous Desktop Mode | In progress |
| FUT-VIS-01 - Live multimodal desktop and mobile vision | In progress |
| FUT-AGENT-01 â€” Intelligent spawning and durable delegated-agent names | In progress |
| FUT-AGENT-02 â€” Visible and accessible active subagents | In progress |
| FUT-CONTACT-01 â€” Agent contact by Raya, email, Telegram and WhatsApp | In progress |
| FUT-ORG-01 â€” Durable organizations that execute company work | In progress |
| FUT-RMSG-01 â€” Messenger-grade Routine conversations | In progress |
| FUT-RCHAT-01 â€” Create routines and organizations from main chat | In progress |
| FUT-PERSIST-01 â€” Restart/rebuild survival for agents and routines | In progress |
| FUT-TODO-01 â€” Personal intelligent Todo and focus timer | In progress |
| FUT-CLOUD-01 â€” Cloud session storage and remote continuation | Planned |
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
| PR-02 â€” Make completion an inspectable agreement | Verified |
| PR-03 â€” Make routine scheduling explicit before activation | Verified |
| PR-06 â€” Publish a supported-client and feature matrix | Verified |
| EN-01 â€” Gate destructive session migration on an explicit upgrade policy | Verified |
| EN-03 â€” Implement timezone and event-filter semantics end to end | Verified |
| EN-04 â€” Acknowledge review actions before dismissing them | Verified |
| EN-06 â€” Preserve the last working canvas across failed updates and restarts | Verified |
| EN-07 â€” Use explicit compatibility contracts during the runtime migration | Verified |
| EN-08 â€” Repair schema regression checks and isolate contract-test state | Verified |
| EN-09 â€” Harden the update path and credential storage | Verified |
| EN-11 â€” Give browser identity and captured authentication a lifecycle | Verified |
| EN-13 â€” Treat recordings and telemetry as separate data products | Verified |
| EN-14 â€” Measure recovery and streaming performance across client boundaries | Verified |
| UX-01 â€” Match review labels to action scope | Verified |
| UX-02 â€” Present progress as current work and next decision | Verified |
| UX-03 â€” Use a consistent interruption and recovery vocabulary | Verified |
| UX-04 â€” Expose context provenance and control where work happens | Verified |
| UX-05 â€” Make history a route back to work, not just a list | Verified |
| UI-01 â€” Test real components in the visual harness | Verified |
| UI-03 â€” Consolidate component semantics while preserving host-specific styling | Verified |
| FUT-CHAT-01 â€” Truthful time in chat | Verified |
| FUT-SKILL-01 â€” Universal role skills for every agent | Verified |
| FUT-ADM-01 â€” Raya admin health and logs | Verified |

## Maintenance and deferred work

| Requirement | Recorded status |
|---|---|
| FUT-BRAND-01 â€” Raya public identity and compatibility-first Kilo migration | Maintenance priority |
| FUT-EDITOR-01 â€” Raya-owned VS Code distribution | Deferred â€” Version 3 |

## Snapshot provenance

Source: integration-worktree `docs/Raya-Implementation-Progress.md`, SHA256 `e1216e4a41c39c1af718a61699f4da03d30664f527cd42d6fbc68afc12a1f217`. All 63 requirement IDs and statuses were extracted once from the same byte snapshot; none were dropped or promoted. The snapshot must be refreshed after a verified status change.
