# Routine calendar scheduling

This describes the implemented calendar-time behavior. The complete routine overhaul remains tracked in [implementation progress](Raya-Implementation-Progress.md).

## Structured schedule creation

Chat's `schedule_task` tool and the panel's phrase input use the same parser in `packages/core/src/kilocode/schedule.ts`. Supported phrases include explicit days and weekdays with valid 12/24-hour times, daily/weekday mornings, positive one-time minute/hour delays (including "once in"), manual aliases (including "only when I ask"), and CI-failure events with an optional exact branch. Branch case and non-default names are preserved. Unsupported recurrence, extra qualifiers and invalid times/delays are rejected; they never silently become manual or weekday schedules. Tool parsing failures return feedback before routine persistence, including when `runNow` was requested. Existing saved schedules are not rewritten by this parser change.

The chat tool requires a `timezone` for calendar recurrence, including explicit cron. Its description instructs the agent to use the user's intended IANA timezone and ask when it is unknown. Missing/blank or invalid zones prevent creation. Delay, event and manual requests omit timezone; supplying one returns a targeted error rather than silently ignoring it. Successful calendar results report the persisted cron/timezone and actual enabled state, and explain that Raya's backend must be running. Structured result metadata includes the saved schedule and enabled state. Existing saved routines and the panel's separate preview flow are unaffected.

Creation and immediate startup have separate outcomes. If `runNow` fails after creation, the tool reports that the routine was saved and startup needs review, includes its routine ID and any retained claim/run ID, and directs review of the existing routine before retrying. It does not report "Agent not created" for that case. Metadata distinguishes `not-requested`, `started` and `review`. Interruption remains cancellation; the saved routine and uncertain-start evidence remain available through Routines.

When a stable tool call ID is available, a request receipt under `raya/agent-requests` excludes repeated creation for the same session/message/call identity. It stores a canonical argument fingerprint and the completed result. An identical retry replays that historical result, including the original resolved delay time; changed arguments or an unfinished receipt require review. Receipt reservation precedes tool execution, and completion publication follows it. Cancellation or failure to save the final result leaves a pending receipt, never permission to create again. Receipt expiry/cleanup and resolving pending attempts are not yet implemented. Different call identities and calls without a call ID are outside this deduplication scope. This does not provide exactly-once external execution.

The creation form offers daily, selected-weekday, monthly, one-time-delay, absolute-date, event and manual controls. Advanced cron remains available for recurrence patterns outside the simpler controls. Weekday selection is explicit; selecting Monday produces Monday-only execution. Monthly dates absent from a month are skipped, as explained alongside the day selector. The one-time delay is measured when preview is requested, not when confirmation is clicked.

Event schedules expose an event source and a choice between any filter value and an exact match. Exact values preserve case, spaces and empty strings. An empty exact value matches only an empty event filter; it does not mean any value. A connected integration must actually emit the selected source.

Templates populate the corresponding controls. Cron expressions that cannot be represented by those controls stay intact in the advanced field. A template containing a fixed one-shot date opens that date in the absolute-date controls; past dates must be changed before they can be confirmed.

## One-shot calendar dates

Choose **Once on a date**, enter a calendar date and time, and review the calendar timezone. Preview sends the local value and timezone to the backend, which resolves them using its timezone database. It returns a canonical one-shot timestamp and the normalized display timezone. Confirmation saves that exact timestamp; local-date proposals cannot be submitted directly through the extension's creation path without a preview.

Times skipped by a clock change are rejected rather than shifted. A time that occurs twice requires choosing the first or second occurrence and previewing again. This includes half-hour clock changes. The preview displays the resolved occurrence with its timezone, allowing the choice to be checked before saving. Input supports years 1000–9999 and optional seconds and milliseconds; invalid dates and rollover values are rejected.

Existing one-shot schedules store an absolute timestamp, not their original presentation timezone. The editor displays that instant in the user's current browser timezone, explicitly identifies the timezone, and preserves seconds and milliseconds. Ambiguous wall times require an explicit occurrence choice even when editing an existing date. Changing the timezone reinterprets the entered wall time in the new timezone and invalidates the preview. Switching to **Once after a delay** remains available.

Resolution samples timezone offsets at one-minute intervals over the 36 hours on either side of the entered date, then verifies candidate instants against the full local clock. It yields between batches. Tests cover modern seasonal changes, half-hour folds and gaps, quarter-hour offsets, leap days, invalid dates and fractional seconds. This is not a claim of exhaustive coverage of every historical timezone transition or a production latency guarantee.

## Editing an existing routine

Choose **Edit schedule** on a routine to see its current schedule and use the structured controls. The edit changes only its schedule; paused state, role, objective, capabilities and workspace remain intact. A completed one-shot can be rescheduled by choosing a future date or a fresh delay. Existing unfinished work continues and prevents overlap with the new schedule version.

Preview captures the routine identity, original schedule and version along with the proposed schedule. Confirmation submits that exact proposal with both preconditions. A preview cannot be reused for a different routine or for creation. The editor closes only after the matching save acknowledgement; unrelated list refreshes and acknowledgements cannot dismiss it. Controls are disabled during submission. On failure the error remains visible, with a route back to the roster to reload before trying again.

Legacy routines without a timezone show a notice requiring review of the intended timezone. Malformed stored calendar values can be carried as preconditions so they can be replaced with a valid schedule; the replacement still goes through normal validation and preview.

## Phrase compatibility for other callers

The extension accepts a deliberately bounded grammar. Named weekdays select that day only; `every Monday at 9am` does not select all weekdays. Supported forms include daily or weekday schedules with an explicit time, a named weekday with an explicit time, `every morning`, `weekday mornings`, positive delays such as `in 2 hours`, and explicit manual schedules such as `just when I ask`. Times use 1–12 with am/pm or 0–23 without it, with minutes from 00–59.

`when CI fails on Feature/Fix-123` preserves the exact branch filter, including case. Omitting the branch means any branch. Unsupported trailing conditions, recurrence intervals such as `every 2 hours`, and relative calendar phrases such as `tomorrow morning` report an error rather than becoming a different schedule. Invalid phrase input is rejected before creating a requested folder or calling the routine API. An omitted or empty phrase retains the existing manual default for callers.

## Preview and confirmation

The creation form includes an editable timezone, initially taken from the user's browser, and requires a schedule preview before assignment. It sends a typed schedule directly; phrase interpretation is not involved in this path. The backend normalizes the timezone and calculates the next three occurrences with the same cooperative evaluator used for execution. A future one-shot schedule returns one occurrence; manual and event schedules return none. Editing any schedule control invalidates the confirmation, and responses for superseded requests are ignored. Existing saved routines are not rewritten, because their original intended phrase is not recoverable from the schedule alone.

The extension retains the exact previewed schedule behind a confirmation token scoped to the current client and directory. This preserves a one-shot timestamp instead of recalculating its relative delay when the user confirms. Tokens expire after ten minutes; the cache retains at most 32 previews. A past one-shot timestamp or a calendar preview whose first occurrence has passed must be previewed again. A token can be submitted once, and an uncertain response does not automatically resubmit it. The user is directed to check the routine list. This is an in-memory submission guard, not durable request reconciliation across restarts.

The read-only `POST /kilocode/agent-forecast` endpoint does not create a routine. It accepts canonical schedules or a preview-only local-date proposal. Other API callers can still submit canonical schedules directly. Live visual verification and durable creation reconciliation remain open.

## Schedule update preconditions

The routine update API accepts an optional `expectedSchedule`: the schedule from the caller's previous read. The backend compares it with the current record while holding the routine mutation gate. If it differs, the update fails with an actionable error before publishing any fields. A schedule update therefore can preserve unrelated changes, such as a newer routine name, while rejecting a stale schedule editor. Callers that omit this precondition retain the previous unconditional update behavior.

Callers can also send `expectedScheduleVersion` from the previous read. This rejects an intervening edit even if the schedule was subsequently changed back to its earlier contents. Both checks happen under the same mutation gate. The extension's existing-schedule editor supplies both preconditions from its captured preview.

## Schedule versions and rescheduling

New routines start with schedule version 1. A changed schedule increments `scheduleVersion` and records `scheduleUpdatedAt`. Renaming, pausing, enabling, changing the objective or submitting the identical stored schedule does not increment it. Version exhaustion rejects a schedule change before publication. These fields version the schedule; they do not archive the entire routine definition.

Each new run records the version selected at startup, and later history updates cannot relabel it. A scheduled one-shot run consumes that schedule version. New manual starts do not consume future scheduled occurrences. Older runs without trigger evidence retain their previous consumption behavior because their trigger cannot be inferred safely. Changing the one-shot to another time creates a new version that can run after older unfinished work has settled. All unfinished runs still exclude overlap, regardless of their version or trigger. New calendar versions start after their edit time instead of replaying an occurrence just before the edit.

Records written before versioning are treated as version 1. Existing history does not need an eager rewrite. Reopening storage preserves both legacy consumption and the eligibility/consumption of a revised schedule. Runs from an older version cannot disable the current version through the repeated-block guard.

History retains unfinished runs, the latest 50 terminal records, and one consumption anchor for the newest recorded schedule version if it falls outside that window. The anchor is the greatest scheduled timestamp among timer runs, with startup time used for legacy records. New manual/event records cannot replace it. This prevents late older records or many manual runs from evicting a newer consumed occurrence. Archived definition snapshots, a durable occurrence ledger and complete interrupted-start reconciliation remain separate unfinished work.

## Why a run started

New runs carry immutable trigger evidence in their startup claim, session metadata and run history:

| Trigger | Recorded evidence |
|---|---|
| Timer | Scheduled timestamp, original poll timestamp, evaluated calendar timezone when applicable, and a deterministic occurrence ID derived from routine ID, schedule version and scheduled timestamp. |
| Manual | Explicit manual-start classification. |
| Event | Source, exact supplied filter including case/empty values, and receipt time at the runner. This is not the event producer's occurrence time. |

The claim stores this evidence before session creation begins and preserves it when the session is linked. If that evidence write fails, session creation does not begin and ownership remains available for inspection/reconciliation. A later session-creation failure retains the selected evidence. These are separate writes, not a transaction spanning the claim, session, goal and run history.

The history API returns the evidence. Routine rows distinguish scheduled, manual and event starts and show startup time separately from the scheduled time. Older runs say that their trigger was not recorded. The existing `run.at` is the beginning of the startup attempt, not proof that model execution began at that instant. History writes cannot change an existing run's startup time, session, schedule version or recorded trigger.

Calendar consumption advances using the greatest recorded scheduled timestamp in the current version, not the last history publication or the startup clock. A backward clock change between polling and startup or a late update to an older run therefore cannot move that cursor backward. Existing polling-window and overlap rules still apply.

The deterministic timer ID is persisted evidence, not an atomic uniqueness constraint across a durable occurrence queue. Event IDs/deduplication, queued or missed occurrence records, leases/heartbeats, catch-up policy and complete startup reconciliation remain unfinished. No exactly-once external side-effect guarantee is implied.

## Timezone

Calendar schedules use the stored `schedule.tz` to interpret their minute, hour, date, month and weekday. The returned occurrence is an absolute timestamp. Hosts in different timezones calculate the same occurrence for the same explicit schedule and reference timestamp, provided their timezone databases agree.

New calendar schedules persist a timezone. When the caller omits it, the backend captures its current timezone at creation. An explicit timezone is validated and normalized by the runtime's timezone database. Invalid values reject creation or a schedule edit before the roster is published. An ordinary edit that does not replace the schedule preserves its existing timezone.

Legacy cron schedules with a missing or blank timezone require review before further automatic admission. Raya preserves their stored definitions, history and selected queue entries without guessing a zone. Manual Run now remains subject to the existing overlap and recovery guards. The editor starts with an empty timezone; choosing and previewing the intended zone creates a version-checked schedule edit, so an old selected occurrence cannot run under the new zone. New cron creation, mutation and forecast requests must supply an explicit nonblank zone. The original intended timezone cannot be recovered reliably from the old record.

## Clock changes

The evaluator searches absolute minutes in increasing order and compares their local calendar fields in the selected timezone.

- A nonexistent local time during a forward clock change is skipped. For example, Toronto's daily 02:30 schedule skips the spring transition date where 02:30 does not occur.
- A repeated local minute during a backward clock change has two distinct absolute occurrences. Both are eligible at the evaluator level and receive distinct timer occurrence IDs if selected. Existing overlap exclusion may prevent a second run while the first is unfinished. A durable occurrence queue and an explicit product control for duplicate-hour policy are still outstanding.
- Fractional-hour offsets and thirty-minute clock changes use the same timezone conversion. The evaluator does not assume an integer-hour UTC offset or a one-hour daylight-saving transition.
- Next occurrence is strictly after the supplied reference timestamp. The task-level due calculation applies its existing polling window around that evaluator.

## Supported recurrence grammar

The five fields are minute (0–59), hour (0–23), day of month (1–31), month (1–12), and weekday (0–7, where both 0 and 7 mean Sunday).

- `*` selects every value in that field.
- Comma-separated integers and ascending inclusive ranges select their combined values, for example `1,3-5`.
- `/n` applies a positive integer step from the range's first value. `*/2` in the month field means January, March, May, July, September and November. In the day-of-month field it means 1, 3, 5 and so on.
- A stepped single value extends to the field maximum: `5/20` in the minute field means 5, 25 and 45.
- Sunday 7 works in lists and ranges as well as alone. Descending/wrapping ranges are rejected; use a list to express a range across the end of a week.
- Named months/weekdays, seconds/year fields, `?`, `L`, `W`, `#`, decimals, empty list entries, zero/negative steps and malformed operators are rejected. Expressions longer than 1,024 characters are rejected before parsing.

New schedules and schedule replacements use the same parser as execution and reject invalid syntax, out-of-range values and month/date combinations with no possible date before saving. February 29 remains valid; February 30 is rejected. Lists remain valid when at least one selected month/date combination is possible. This does not prove that a selected local clock time exists in the chosen timezone on a matching date.

## Current limits

The evaluator retains day-of-month/weekday intersection behavior: when both are restricted, both must match. Its bounded search now spans one 400-year Gregorian date/weekday cycle plus two days for UTC/local date boundaries, capped at JavaScript's supported timestamp range. This supports leap-day recurrences and date/weekday combinations that are many years apart, including century exceptions. Nonfinite or out-of-range reference timestamps are rejected. An expression with no actual matching local minute inside that horizon raises an error; recurring daylight-saving gaps can produce that result even for a possible calendar date.

Migration of invalid legacy schedules and user-facing interpretation still need implementation. Polling and preview use a cooperative evaluator that yields to the host event loop after each batch of at most 1,024 scan iterations. Waiting between batches is interruptible. The synchronous helper uses the same scan logic for direct callers, preserving identical occurrence semantics.

Sparse-minute schedules use a timezone-aware minute filter before full calendar conversion. Cooperative evaluation avoids running an entire long search in one uninterrupted block, but does not eliminate its total cost. Timer dispatch evaluates and delivers routines through four concurrent workers, so an eligible routine can start while another worker is still evaluating. Queued work waits when all four workers are occupied. Cancellation interrupts active workers and prevents queued callbacks from starting; it does not undo work already started.

The compatibility ready-list method and list preview still return complete lists. A preview can await an expensive search even while the event loop remains available. Throughput, request cancellation integration, starvation prevention under sustained expensive work and production latency bounds need further verification.

## Poll lifecycle

The timer attempts a poll immediately, then waits 60 seconds after each completed or failed attempt. Poll failures and defects are logged and allow another attempt after that delay. Interruption stops the loop and is not treated as a retryable failure. This preserves the existing fixed-delay cadence; it does not provide a catch-up policy or compensate for time spent evaluating and starting work.

Before a timer-selected routine creates a session, it acquires startup ownership and rereads its definition and history. Eligibility is checked against the original poll timestamp. A completed one-shot run, a future reschedule or a switch to manual/event scheduling prevents that selected timer start and releases the unused claim. Manual starts retain their separate behavior. This is a startup eligibility check, not durable occurrence identity or a transaction covering edits after the check.

The timer and dispatched turn-close/permission/question callback work are scoped to the routine subscription. Closing that scope interrupts active callback work and the timer and unregisters its event listeners. A queued listener invocation cannot start callback work in a scope that is already closed. Small storage mutation sections that deliberately mask interruption can finish their local publication before closure completes.

Bootstrap obtains the routine subscription through the existing instance-state cache. Repeated and concurrent initialization of the same instance shares one subscription; instance disposal closes it, and subsequent initialization can create a fresh subscription. Distinct instances can still own separate subscriptions against shared routine storage; cross-instance execution ownership remains a separate concern.

Integration tests use the real event bus and temporary filesystem storage to verify interruption of active turn-close delivery without publishing a terminal run, and disposal/reinitialization through the actual instance disposal registry. Detached model continuations, full backend process teardown, cross-instance scheduling and recovery still need verification and further work.

Polling isolates calendar-evaluation failures per routine and skips that routine for the current poll. List previews clear its computed next run and show a schedule diagnostic alongside any stored note; the roster renders those notes without a two-line clamp. The diagnostic is derived, not saved over the definition, and disappears after a successful schedule repair. Evaluation failures are also logged. This isolation covers schedule evaluation; it does not hide storage read failures or corruption that prevents decoding the roster or a run history.

Calendar-day exclusion avoids converting every minute of a year for sparse schedules. It considers adjacent calendar dates around each UTC date before excluding a day; candidate minutes still receive full timezone conversion. Annual occurrences on either side of the UTC date boundary are covered by regression tests.

Selected timer occurrences are now durably queued before session startup and reused after reopening, even outside the original polling window. Queue reservation, session linking and terminal reconciliation supplement existing startup claims. See [the queue contract](Raya-Routine-Queue.md) for ownership boundaries and recovery gaps. Missed wakeups that were never selected, event receipt deduplication and durable catch-up policy remain incomplete. This document does not promise execution while the backend is stopped or exactly-once execution across restarts.

## Creation-screen role and template consent

Choosing a role clears the draft's sensitive-record consent instead of enabling it. Applying a template follows the same rule; its capability list is not evidence of user consent. Accountant and Inbox assignments require their respective checkbox to be selected explicitly. Both the submit button and submit handler enforce this, while the existing server guards remain authoritative. Switching templates clears earlier consent rather than transferring it to a different job.

Role/template selection preserves the separate workspace-access choice and no longer changes it to full write access. A fresh creation screen starts with read/notify access. Explicit workspace-access selections remain available. The backend also persists brief access for every newly created routine when access is omitted, independent of its role. Existing saved definitions are not rewritten by this default change.

The scheduling tool accepts optional `access: "brief" | "full"`, tells callers that full access requires user authorization, and includes the saved access in its result text and metadata. An explicit full selection remains supported. Brief mode's edit/write/bash/apply_patch deny rules are applied after any custom tool list, so wildcard or direct allow entries cannot override them. An explicitly full routine with a tool list remains limited by that list.

Before creation, the model-facing tool calls the session permission policy with permission `schedule_task`. Patterns include `access:brief` or `access:full`, plus each distinct lowercased requested capability as `capability:<name>`. Policy metadata includes the proposed name, objective, role, schedule, access, capabilities, plan and immediate-start choice. Existing allow rules may approve automatically; this does not force a prompt or independently prove human consent. Capability names are literal patterns: a rule for `capability:money` does not cover other aliases; use `capability:*` when the restriction should cover every capability.

The check runs inside the existing request receipt and before saving a definition or starting work. Completed receipt replay returns its saved result without requesting authority or executing creation again. A denied or interrupted permission request cannot create a routine; an incomplete receipt remains conservative and requires review on retry. This tool boundary does not add authorization to direct HTTP callers or constrain every downstream external effect.

Older definitions without access now require review before future starts. Preview clears their next occurrence and explains Review access; timer eligibility, event selection and startup reject an unset choice. Existing sessions are not cancelled or assigned new permissions. The roster disables new-run actions for these definitions while keeping conversation/recovery navigation available.

Review access opens a focused panel with no preselected choice. Saving sends only access and `expectedAccess` (`brief`, `full`, or `unset`) to the update API. The mutation gate checks the current access before replacing the roster, rejecting stale reviews. It does not enable the routine, reset its failure count, change its schedule or start work. Dedicated request/response IDs and routine identity bind acknowledgements to the panel. Errors or a 15-second timeout require closing/reloading; late replies cannot show success. Closing restores focus unless a newer review panel has opened. Polling does not reset the open review's choice, and access/run review panels are mutually exclusive.

This is not a complete authority envelope. The conditional check covers access, not every concurrent role/model/tool edit. External tool effects, delegation boundaries and proof of user authorization in model-originated requests remain broader audit work. Brief mode's named restrictions are not a sandbox or a general guarantee against all possible side effects. Output/acceptance configuration and end-to-end permission enforcement remain unfinished.

## Output contract

The routine API and scheduling tool accept an optional `output` object. Its supported destination is `conversation`: the result belongs in the run's retained conversation. `description` specifies the deliverable. `criteria` contains 1–20 required entries with a unique stable `id`, a `description` and explicit `verification` instructions. IDs allow letters, digits, underscores and hyphens, begin with a letter or digit, and are at most 64 characters. Descriptions and verification instructions must contain non-whitespace text and are limited to 4,000 characters each.

Creation and updates validate the contract before saving. Invalid updates preserve the previous definition, and an unrelated edit preserves its output contract. Startup records the contract in the immutable definition snapshot and includes the deliverable, criterion IDs and verification instructions in the goal objective. Later definition edits apply to future starts. The scheduling tool includes the contract in permission-review metadata and returns the saved contract with its result.

The assignment form requires a deliverable and at least one criterion with verification instructions. Users can add up to 20 criteria or remove extras; generated IDs stay stable while editing. Adding focuses the new criterion, and removing returns focus to Add criterion. Choosing another template clears the previous output requirements. Blank or invalid requirements disable assignment and are also checked in the submit handler. The extension validates supplied contracts before creating folders or consuming the schedule confirmation, then forwards the complete contract through the generated SDK. Schedule-only editing does not require re-entering output requirements.

Edit output opens the saved requirements in the shared review area. Older routines without a contract open with blank required fields. Saving sends only `output` and `expectedOutput` (the reviewed contract or `unset`); the backend checks the precondition under the mutation gate and rejects a stale contract. This does not version unrelated definition fields or detect a change that was subsequently reverted to exactly the original contract. Saving does not enable or launch work, and an existing startup snapshot keeps its earlier requirements.

Output, access and run reviews are mutually exclusive. Polling preserves the open output draft and its original precondition. Replies must match the request, routine and submitted contract before showing success. Errors and a 15-second uncertainty deadline require closing and reloading; late replies cannot confirm a timed-out or closed save. Closing restores focus to Edit output unless another review has opened. No automatic save retry occurs.

For new runs with an output contract, startup also saves the selected criteria as authoritative goal data before dispatch. `get_goal` exposes them. A completion audit must include exactly one entry for every saved `criterionID`, preserve its saved description as the requirement text, and satisfy the existing passed/evidence checks. Unknown IDs, duplicate or omitted criteria and weakened descriptions are rejected. Additional requirements derived from the broader objective remain permitted and must also pass evidence checks. Rejected audits persist the submitted attempt and leave the goal open.

Goal-objective revisions preserve those criteria. Retrying goal creation with identical objective and criteria returns the existing active goal; a changed or omitted criteria list cannot replace it. Editing a routine definition affects future runs, not the criteria already attached to a goal. Existing goals without structured criteria retain their prior completion behavior; no in-flight goals are silently migrated.

This enforces criterion coverage and links it to the existing completed-tool validation. It does not establish that a tool result semantically proves a criterion, that an artifact is unchanged since verification, or that a person approved a judgment call. Required-field migration, revision-aware evidence validity, human-review states and stronger verification methods remain unfinished. No external destination, delivery authorization or notification deduplication is implemented by this contract. Native visual/accessibility and packaged validation remain open.

## Workflow starters

The catalog includes five workflow starters alongside the existing Accountant and Inbox templates. Existing briefer/reviewer IDs are retained, so the catalog update does not rewrite saved routines. Templates populate ordinary editable instructions and schedules; they do not activate work or establish permissions.

| Starter | Proposed trigger | Expected result and checks |
|---|---|---|
| Morning project brief | Weekdays at 09:00 | Changes, risks and next actions in the run conversation, with reviewed period, file/commit references and gaps. |
| Weekly document review | Friday at 16:00 | Prioritized document issues, paths/sections, proposed corrections and unresolved questions; source documents remain unchanged. |
| Watched-folder report | On demand | Folder-change report against the previous report, or an explicit first-run baseline; identify unreadable/missing files. |
| Repository maintenance check | Weekdays at 18:00 | Evidence-backed findings and proposed fixes; distinguish observed failures from suspected risks and unperformed checks. |
| Research digest | Monday at 10:00 | Findings, source links, available publication dates, disagreements and questions; request a missing topic instead of inventing one. |

Calendar proposals use the creation screen's chosen timezone and require schedule preview. The folder starter does not install a watcher or claim automatic event delivery; users must configure a supported trigger separately. Select the source folder and edit topic/source requirements before assigning. Results are requested in the run conversation; external delivery and write actions are not granted by a template. These instructions provide editable output/check guidance, not structured output schemas or enforcement of arbitrary external effects. Dedicated output/acceptance fields, watcher integration, richer template previews and representative live-workflow validation remain unfinished.

## Current scheduling policy (EN-03)

Recurring schedules use their saved timezone. New cron schedules and edits must make that timezone explicit. Legacy cron definitions without one require timezone review before automatic admission; history and already-recorded execution evidence are preserved. Choosing a timezone does not retroactively establish what the user intended on another host.

### Sleep and missed occurrences

For recurring work that has not yet been selected into the execution queue, Raya admits only an occurrence less than one minute old. At exactly one minute late it skips that occurrence and looks forward. Waking after several days does not create a backlog of every missed recurrence. For example, a daily 09:00 routine can be selected at 09:00:59, but a first scheduler observation at 09:01:00 skips that day's run.

One-time schedules remain due after their specified time until their occurrence is consumed, the schedule changes, or the routine is paused/removed. Existing overlap and recovery guards still apply; an overdue timestamp is not permission to create a duplicate run.

A run already recorded as queued is a different case from an unselected missed occurrence. It retains its selected timestamp and can be admitted later after restart, subject to the current schedule version, enabled state, timezone review and ownership checks. Starting or uncertain runs require the existing recovery flow. This policy does not discard their evidence or automatically replay uncertain work.

These rules apply when Raya's scheduler runs; they do not promise execution while the application is closed, at an exact wall-clock instant, or after every missed recurrence.

### Daylight-saving changes

A local time that does not exist during the spring clock change produces no occurrence that day. A repeated local minute during the autumn clock change represents two distinct increasing instants; a matching recurring schedule can therefore run twice, subject to overlap and lateness guards. The occurrence preview shows the resolved instants. One-time local-time entry separately rejects nonexistent times and requires disambiguation where applicable. These calendar rules are distinct from skipping work because Raya was offline.

### Verification

`test/kilocode/task-catchup.test.ts` exercises the actual next/due functions at the minute boundary, after multi-day gaps, in a saved non-UTC zone, and for consumed/paused one-time work. Existing `task-cron.test.ts` checks nonexistent and repeated local minutes, non-hour clock changes, and explicit zones across host environments. The existing scheduler test `a selected calendar occurrence survives reopening and is reserved before an uncertain session attempt` covers durable queued selection separately. Pending and completed validation outcomes are recorded in the implementation progress document; this file is not a claim that every deployed scheduler/migration scenario has been accepted.
