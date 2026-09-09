---
"raya": patch
"@kilocode/cli": patch
"@kilocode/sdk": patch
---

Keep file-review controls available when saving or undoing changes fails, wait for acknowledgement before dismissing them, and show fresh review controls when file contents change. Clarify file-wide Keep and Undo actions and expose deletion-only changes in editor review.

Fail safely when accepted edit boundaries cannot be read or persisted instead of reporting a successful review or undoing accepted work.

Preserve both accepted boundaries when multiple clients keep different files concurrently through the same backend.

Reject stale Keep and Undo requests when supplied review revisions no longer match, and retain the exact reviewed file scope.

Protect newer saved manual edits by checking guarded review requests against completed snapshots, and preserve those edits when Undo detects a conflict before restoring files.

Save inline chat Keep and Undo actions through the same guarded review flow, and retain file acceptance when transcript content loads later or unrelated files change.

Ask users to save or revert unsaved edits in reviewed files before Keep or Undo, without automatically changing their editor buffers.

Restore kept-file review state from persisted backend boundaries when reopening editor or chat views, and reopen review after later agent edits.

Honor kept work across parent and subagent sessions when reviewing or undoing changes, without importing acceptance from unrelated sibling sessions.

Reuse review request IDs on retry, return completed outcomes without repeating Keep or Undo, and report uncertain interrupted outcomes before another mutation.

Claim review attempts exclusively across backend processes and publish receipt updates atomically so concurrent readers cannot observe partially written outcomes.

Preserve pending review request identities across extension restarts and refresh saved review state when recovering an earlier attempt.

Retain pending chat review identities until the requesting view acknowledges the result, allowing safe recovery when result delivery is interrupted.

Reopen review for later agent edits even when their contents match an earlier edit, and reject commands bound to an older patch event.

Avoid loading unrelated conversation text and tool output when reconstructing file-review identities.

Remove owned review retry metadata when a session's deletion is confirmed, while preserving other sessions and recoverable legacy attempts.

Coordinate final session deletion with review mutations in the same backend, while allowing background cleanup to finish before deletion takes its lock.

Reject review requests for deleted sessions before creating pending retry receipts.
