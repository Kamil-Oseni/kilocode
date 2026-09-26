# Todo installed-host acceptance

This is a live Windows/VS Code acceptance record for `FUT-TODO-01`. The Chromium Todo fixture and unit tests establish source behavior only. Do not mark the feature Verified from those tests or from a VSIX installation alone.

## Run identity

| Field | Evidence |
|---|---|
| Date, timezone, operator | |
| Source commit and VSIX version | |
| Installed VSIX SHA-256 and active PackageVault digest | |
| Running VS Code extension version after **Reload Window** | |
| Backend endpoint/process identity before and after restart | |
| Windows desktop/session identity and notification setting | |
| Model/provider used, with secrets redacted | |
| Session ID and Todo/proposal IDs, if visible | |
| Screenshot or screen recording path, with private content redacted | |

Use a disposable chat and distinctive task titles. Keep VS Code foreground and Windows notifications enabled for the reminder observation. Record actual local timestamps using a wall clock; do not advance a test clock. A source checkout, Chromium fixture, headless server, inactive VSIX, or stale loaded extension makes the installed-host result **ineligible**.

## Live path

| Step | Action | Required observation | Result/evidence |
|---|---|---|---|
| 1. Loaded build | Install the source-matched VSIX, run **Developer: Reload Window**, and confirm the running extension and backend identities. Open Raya's Todo Tasks view. | The loaded extension is the installed candidate; Tasks loads without an offline/stale error. | |
| 2. Real proposal | In Todo's **Ask Raya to plan a todo** field, send: “I want to learn violin. Propose one parent task with a useful ordered set of beginner subtasks, including choosing an instrument and a first practice routine. Let me review before saving.” If the field prepares a chat draft, send that draft in the main chat. | A real model response creates a native **For review** Todo proposal with a parent and sensible subtasks. No task is saved before approval. Capture proposal ID/digest and the actual proposed content. A chat-only list is a failure of this path. | |
| 3. Review and apply | Inspect the proposal, then select **Apply** once. Reload the Todo view. | The parent and child tasks appear exactly once and persist. An uncertain result must reconcile the exact proposal state; do not blindly click Apply again. | |
| 4. Child and restart | Complete one child checkbox, reload, reopen it, then restart the Raya backend and reopen Todo. | The child changes state once per click; the reopened state and parent/subtask IDs survive reload and backend restart. No click is replayed automatically after disconnection. | |
| 5. Priority | Create or use saved open tasks with a future high-priority task, a future low-priority task, and an overdue low-priority task; retain one completed task. View **All tasks**, reload and restart the backend. | Overdue open task precedes future high, future high precedes future low, and completed task is last; order persists. If the model cannot set a priority or due date through the reviewed proposal, record that as a product gap rather than changing hidden storage. | |
| 6. Natural reminder | In **Ask Raya for a reminder**, request a uniquely named reminder for at least three real minutes from now. Send any prepared chat draft, inspect the native proposal's absolute local time, and Apply once. Record requested, proposed, applied and due timestamps. | The reviewed task has the intended saved reminder time. The native `Todo reminder: <title>` notification appears after the real due time with the extension connected. Allow at least one 60-second polling interval and record latency. No duplicate notification appears after acknowledgement, view reload or backend restart. | |
| 7. Focus passage | Open **Focus timer**, set `00:01:00`, optionally link the Todo, and select **Start focus**. Record the wall-clock start and displayed time, reload at about 30 seconds, wait past 60 real seconds, then reload again. | The same saved timer runs through reload; remaining time decreases with real elapsed time and eventually shows completed. Reload/restart must not start another timer or reset elapsed time. Record any difference between displayed and wall-clock duration. | |

For the reminder, if the notification does not arrive by due time plus two poll intervals, record a failure with connection state and timestamps. Do not extend the wait indefinitely or claim success from a unit-test notification stub. For the timer, a fixture that advances a fake clock does not count as passage. If access to the foreground host or its notification surface is unavailable, mark steps 1–7 **not run / ineligible** rather than passed.

## Adverse checks

| Scenario | Required result | Result/evidence |
|---|---|---|
| Deny a second reviewed proposal | No corresponding task appears after reload or restart. | |
| Apply with a changed/stale task | The current saved item is shown; the old proposal does not overwrite it or replay an unknown action. | |
| Disconnect during Apply or a subtask click | Reconnect and read the exact saved state before any retry; there is at most one native effect. | |
| Restart while a reminder is due | At most one notification is delivered and acknowledged, or a recoverable undelivered claim remains visible; no silent duplicate. | |
| Pause/reset timer near completion | State follows the authoritative backend revision, including after reload. | |

Record each step as **pass**, **fail**, or **not run / ineligible**, with timestamped evidence. `FUT-TODO-01` can advance only after the installed path and relevant adverse cases pass. The preview regression (`tests/todo.browser.ts`), Todo proposal/storage tests, reminder coordinator tests and timer bridge tests are supporting evidence, not substitutes for this run.
