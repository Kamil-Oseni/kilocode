# MausBot routines review

Reviewed October 12, 2026. Source snapshot: OpenMausBot commit `731711826bc5c15a26ff5f3614a931047bf4b7dd`. This is a source review; the application was not installed or executed.

## Recommendation

Improve Raya's existing routines instead of replacing their runtime with MausBot. Both products already schedule agent work and retain reports. MausBot's most useful additions are clearer reporting and bounded continuity, which fit Raya's personal-assistant and job workflows without introducing another agent server or VM.

The public project is [OpenMausBot](https://github.com/milind-soni/OpenMausBot), formerly OpenGrokBot. It is a chat application for agents with model/provider selection, connected tools and computer environments. It is an application and orchestration layer, not a new local model.

[LICENSING.md](https://github.com/milind-soni/OpenMausBot/blob/731711826bc5c15a26ff5f3614a931047bf4b7dd/LICENSING.md) licenses the ordinary source under Apache 2.0; `enterprise/` has separate production restrictions. Any later source reuse must preserve the applicable license/notices and avoid assuming the enterprise code is Apache licensed. The improvements below use original Raya code inspired by observed patterns, not copied implementation.

## What to adopt

| Pattern | Maus source | Raya decision |
|---|---|---|
| Next scheduled run visible in the roster | `src/components/routines/RoutineList.tsx`, `src/lib/routine-display.ts` | Show the existing backend-provided `nextRun` in Raya's current row, using the saved calendar timezone. Do not calculate another independent schedule in the UI. |
| Previous reports are historical context | `server/routines.ts`, `composeExecutionPrompt` and `continuityCarry` | Raya already retains up to 8,000 characters of role memory. Respect its saved memory scope and distinguish that report text from current instructions. Preserve stored notes. |
| Progress and results return to the originating conversation | `shared/routine-run.ts`, server reporting hooks | Valuable next slice: upsert one concise run receipt, linked to the isolated worker conversation. Approval remains in the real execution context. Requires durable origin/run identity, not an extra assistant prompt. |
| Existing conversation can receive reports | `src/components/routines/ResultsDestination.tsx` | Use Raya's existing Ask cards for an optional destination choice; retain a clear default. Do not build another settings wizard. Backend authorization and deleted-destination behavior must be defined first. |
| Busy, skipped and missed work is visible | `server/routines.ts`, `src/components/routines/RoutineLogs.tsx` | Keep Raya's current durable occurrence and overlap exclusion. Add explicit user policy and concise outcomes before changing catch-up behavior. |
| Local availability is explained | Routine calendar/display components | Explain once that local routines depend on Raya running and the computer staying awake. Do not change sleep settings automatically. |

## Existing Raya behavior to preserve

Raya already has calendar preview, explicit timezone handling, schedule versions, durable selected occurrences, isolated worker runs, startup snapshots, permissions, waiting-for-input states, role-scoped report storage and an inbox. The relevant implementation lives under `packages/opencode/src/kilocode/task/`, with roster/setup UI in `packages/kilo-vscode/webview-ui/src/components/routines/`.

MausBot's default overlap skip or single queued scheduled run is worth exposing as a simple product choice later. Its twelve-hour late-run cutoff should not become Raya's universal default: a stale reminder, job application or market alert has different consequences. Existing selected occurrences and uncertain interrupted executions must not be silently replayed.

## First implementation slice

- Surface the existing next-run timestamp and local availability constraint in the current routine UI.
- Fix startup injection of old role memory after a routine switches to project/session memory scope.
- Present retained role reports as bounded, potentially stale evidence. Escaping the wrapper helps preserve formatting; it does not make prompt injection impossible. Existing permission enforcement remains necessary.

These are source changes until included in a qualified installed package. They do not establish whole-routine restart, missed-run or production UX acceptance.

The first slice is now included in qualified everyday package `7.4.23-snapshot+1113d35b8b.local.1791820426652`. Five focused tests, full CLI types, host/webview production checks, Knip and independent binary/archive qualification pass; closed installation preserves saved settings/history. The new due-date labels are present in the production bundle. No new loaded-GUI, routine-run, missed-run or human UX acceptance is claimed; exact evidence is recorded in `Raya-Implementation-Progress.md`.

## Follow-up implementation

Return one compact, updateable run receipt to the conversation that requested the job: Running, Needs your input, Completed or Failed, with its actual result and an Open run action. Then add report destination and explicit missed/overlap policy through existing Ask cards. Examples include job searches, an Eden daily brief, groceries, and project follow-ups; external messages/orders still follow their existing authorization rules.

Do not replace Raya's provider/tool runtime, memory service or recovery system with MausBot's Electron/server stack. Port useful behavior through Raya's existing contracts, and use small targeted checks for each changed boundary.
