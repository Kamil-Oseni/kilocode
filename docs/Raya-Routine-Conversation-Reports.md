# Conversation routine reports

This feature keeps background execution in its worker conversation and shows saved progress/results in the conversation that requested the routine. Reports do not create user messages, submit prompts or start another model turn.

## Reporting destination

Open **Routine reports** in the conversation header to read saved progress and results. Choose **Report conversation** in the routine's existing review form to set its destination; use **View worker conversation** for the actual run and its questions or approvals.

- A routine requested in conversation defaults to reporting there.
- Choose another existing ordinary conversation in the same workspace to receive its reports.
- With no current conversation, an explicitly selected report conversation is supported without inventing an originating chat.
- Older routines with neither setting keep their existing worker-conversation reporting until configured.

Each scheduled occurrence uses one stable report card through queued, running and terminal states. A report links to its worker only after a worker session exists. Questions and approvals stay in that real execution context; a report card is not approval authority. The destination is frozen for an occurrence once its report is published. Editing the routine affects future reports, not an already-published occurrence. A deleted or unavailable destination is retained as unavailable and is never silently redirected.

## Waiting notices

When a selected occurrence remains queued behind an active run for more than 30 minutes, Raya retains one notice for that occurrence. Repeated polls and reopening do not create another inbox notice. If report projection fails, it can retry using the same durable receipt. The notice remains attached to the report after the worker starts or finishes. A routine already waiting for your answer does not receive another generic long-wait notice.

This is an in-app report/inbox notice, not permission to send external messages or phone notifications.

## Busy and missed runs

| Choice | Behaviour |
|---|---|
| Busy: Skip | Record a skipped occurrence rather than start overlapping work. |
| Busy: Queue one | Keep one selected occurrence waiting until the current run settles. Later observations do not create a backlog. |
| Missed: Skip | Record an elapsed occurrence as skipped beyond the normal polling grace. |
| Missed: Run latest once | Select at most the latest eligible elapsed occurrence; do not replay every missed interval. |

Existing routines without explicit choices keep legacy scheduling semantics. Policy changes are reviewed with the schedule and increment its version. Older selected occurrences are retired by the existing version/recovery machinery; active leases and recorded history are preserved. A queued occurrence retains its original identity and observation time when promoted for execution.

These choices apply to calendar scheduling. They do not duplicate manual runs or authorize replay of uncertain external side effects. Local execution still requires Raya running and the PC awake.

## Validation scope

Focused physical SQLite/storage checks cover policies, queue identity and leases, report revision/idempotence, destination binding, waiting-notice persistence and publication guards. The report's own publication scope is guarded without revoking the observed worker's execution scopes. Actual HTTP checks cover report reads and invalid destinations. Positive routine writes are qualified at the physical service boundary; the default HTTP unit fixture uses an in-memory database that cannot satisfy the physical authority guard.

The current installed package is `7.4.23-snapshot+c7c8c07ce1.local.1791829554106`. A real pinned local 4B worker read its scoped private fixture, completed its Goal with tool evidence and saved the result card to the selected conversation. A fresh backend reopened the saved report with the model unloaded, without replaying inference or changing the earlier failed runs. This establishes that installed worker/report path; it does not establish every everyday routine or external action.
