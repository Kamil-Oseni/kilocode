# Everyday Raya experience

Conversation, coding, delegated jobs, routines and goals remain first-class workflows. This upgrade is successful when Raya finishes ordinary work and reports observed results, not merely when its services are reachable.

## Source changes

| Area | Implemented behavior | Acceptance still needed |
|---|---|---|
| Navigation | Conversation, Tasks, Routines, Memory, Activity and health, and Settings are directly accessible. Opening Conversation does not create another session. | Integrated installed-window check. |
| Live activity | Voice phases and current-turn running tools determine the displayed status. A previous turn's tool cannot imply a current search. Workers show the model reported by their actual assistant messages. | Human continuous speech and Stop check. |
| Memory review | Project corrections require an exact preview. SecondBrain proposals show source hashes and before/after text; edits change the proposal, and applying requires native review of the selected revision. Project changes invalidate old responses. Automatic capture stays off. The matching proposal backend is integrated. | Inspect a disposable proposal and native review in the installed client; normal-corpus acceptance remains separate. |
| Dynamic moods | Save named palettes and optional research sources, with bounded duration and staggered movement. Existing device approvals and allowlists remain effective. Each mutation uses observed-state verification; external light changes retire the cycle. Saved moods do not autoplay after restart. | Explicit user-requested physical playback and interruption test. |
| Background capacity | The shared inference queue reserves waiting count and bytes for conversation and retains fairness for background work. Routine ancestry selects the background lane. | Integrated installed conversation while a job is active. |
| Context | Ask, Code and Voice fixed prompts fit a 32K configuration with bounded catalogs; recall uses the transcript index and active-turn exclusion. | Long conversation and selected-memory acceptance on the installed build. |
| Jobs and routines | Activity and health includes current-conversation workers, tool detail, elapsed time, reports and Stop. In-flight Stop is not repeated; missing receipts trigger a status read, not another cancellation. | Real permitted file-writing delegation with readback, routine periods, pause/stop, and no replay. |
| Saved file results | Write and edit compare saved bytes against the intended encoded output. Patch checks resulting files and absent paths. Unavailable or mismatched readback reports an executed, unconfirmed mutation without requesting automatic replay; it cannot support verified Goal completion. | Installed delegated file task and readback. |
| Resources and recovery | Activity and health displays installed extension/backend identity, existing service states, shared backend RSS/heap, host free/total RAM, local queue activity and host-verified retained rollback metadata. Pending update/repair journals prevent an availability claim. Separate model/speech and GPU memory are not attributed to workers. | Installed-build and matching-build recovery evidence; actual restore remains a separate action. |

The proposal interface requires the matching native/backend contract; do not install the UI commit alone. Runtime health does not establish microphone, model adherence, physical-device or recovery acceptance. The broader readiness checklist remains version-scoped and independent of these source checks.

## Validation recorded on 2026-10-05

- The first UI and mood batch passed 60 focused extension tests (392 assertions), nine genuine backend Home Assistant eligibility checks (128 assertions), and browser layout/accessibility checks at narrow and wide widths in light and dark themes. Types, lint, unused-export checks and the production bundle passed.
- Proposal editing preserves input focus. Browser transport checks verify revision-aware edit/apply, workspace invalidation and dismissed native review without an applied claim. Combined host and webview types pass against the regenerated backend SDK. These transport-boundary checks do not establish genuine model-to-Store acceptance.
- Seventeen voice dispatch, draft, mounted-session, Stop and playback-correlation tests passed (63 assertions). Mounted checks use Playwright's bundled browser because installed Edge refused test-profile launches before application code.
- Nineteen actual HTTP scheduler and persisted-lane checks passed (118 assertions), including background saturation, queued/active cancellation, stream failures and ordinary slot release.
- Ask, Code, routing and indexed recall checks passed. The Voice catalog expectation was corrected to include its read-only web-fetch tool; the Voice budget and Home Assistant eligibility checks then passed all 11 cases (143 assertions).
- Resource collection passed 11 service/registry/real-stream cases (65 assertions) and the production HTTP listener check (six assertions). Narrow-layout checks passed; worker Stop tests verify pending confirmation, status recovery after a lost receipt and one cancellation command.
- Archive, journal and host checks verify read-only rollback availability. The host drops any backend-supplied rollback claim and adds only its own verification result. The browser checks verified checksum display and invalid/in-progress states at 320px. Combined extension host, webview and CLI types pass with the generated proposal/resource contract.
- The complete focused admin/browser suite passed all 18 cases, including proposal transport, pending and lost Stop receipts, resources, rollback, narrow layouts, keyboard access, service failures and retry.
- Six real artifact read/patch tests passed with 72 assertions. The subsequent saved-byte confirmation repair closes the unavailable-readback success-message gap. Independent checks in this worktree passed all 11 write/edit/patch cases with 102 assertions, including changed/missing readback and a recreated deleted path. These checks establish source behavior, not installed or local-model task acceptance.
- The maintained SDK generator cancellation repair passed four independent actual-stream tests with 12 assertions. It joins cancellation without losing a distinct read or validation failure.
- A one-minute real-time mood expiry check passed with 156 assertions against the actual HTTP adapter. The cycle completes, stops further writes, preserves the last reported colour, clears its action journal and reopens idle without playback. This is a local fixture check, not physical light acceptance.

No microphone capture, audible playback, physical light change or automatic memory capture was performed by these checks.

## Installed observation on 2026-10-05

The normal VS Code window reported extension `7.4.23-snapshot+a5aca91bf3.local.1791237757513`, connected on port 4096. Activity and health displayed backend PID 25828, RSS 0.72 GiB, heap 0.27/0.43 GiB, host available/total RAM 15.20/31.38 GiB and an idle inference queue. The six navigation destinations were present, and the Conversation view retained model and voice controls. This observation does not prove task execution, cancellation or speech continuity.

Two installed presentation failures were reproduced and repaired in source:

- Rollback verification rejected the lowercase drive letter supplied by VS Code `fsPath`. The verifier now normalizes only the Windows drive letter; archive, binary, canonical-path, link and race checks remain. The same real retained vault changed from invalid to available in the read-only source check, identifying the prior b560 build and its verified receipts. No package or vault record was changed.
- Backend identity was absent because the connection service published only its port. It now observes the connected backend's authenticated health response with a three-second deadline, validates its identity and publishes the returned version only for the current connection generation. It does not substitute the extension version.

The repair passed 17 tests with 64 assertions, including actual Windows archives, journal immutability, corrupted receipts and real SDK HTTP identity responses. Extension types, lint, Knip and bundling passed. A matching reinstall and installed-interface recheck remain pending.

Voice's attention status was referred to the integration owner: retained failed voice sessions can degrade its registry status even when the speech service is ready. Historical failures must remain visible without implying an unobserved current service outage.
