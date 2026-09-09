# Cloud history continuity

This implementation addresses the request and selection correctness portion of UX-05. Release validation is recorded separately in the implementation progress log.

Cloud-history list requests carry a unique request ID through the extension host. Only the current request may update rows, pagination, loading or failure state. A repository-filter change supersedes the prior request and clears rows from the old scope. Responses and errors from the old scope cannot appear in the new list. Component disposal cancels its local timeout and message subscription; reopening history uses new request IDs.

Refresh within the same scope keeps the existing rows visible. A successful response reconciles rows by session ID. The shared list's opt-in `preserveActive` setting retains the active keyboard row if that ID still exists and the search has not changed. A removed row or changed search uses the existing first-result fallback. Default behavior for other lists remains unchanged. Refreshing never opens a session automatically.

The host distinguishes a failed HTTP response, missing response data, disconnection and thrown transport failure from a successful empty list. Failures return a scoped message, release loading, and expose a retry action. Pagination failures preserve loaded rows and the failed cursor; retry requests that same cursor with a new request ID. Duplicate session IDs on a later page are not added again. The host request has a 30-second timeout, with a 35-second webview deadline for a missing acknowledgement. Late replies after that deadline are ignored.

## Limits and follow-up

This change does not infer a session's project, alter import destinations, or redefine cloud preview. The history import dialog still opens a read-only cloud preview; the existing first-send flow imports into the provider's workspace directory. Explicit destination review and richer project/result/required-action metadata remain separate UX-05 work. Local and cloud session identities stay distinct.

## Validation targets

- `tests/unit/cloud-history.test.ts` drives the actual host handler through the shipped SDK against a local HTTP server: non-2xx failure, successful empty results, scoped disconnection/transport failures and pagination forwarding.
- `tests/unit/cloud-history-view.test.ts` runs the production `CloudSessionList` and shared `List` with actual providers: delayed repository replies, refresh and pagination retries, retained keyboard selection/focus, removal and search fallbacks, deduplication and no automatic navigation.
- Existing history accessibility browser tests remain relevant for source-tab navigation and row actions; this slice does not replace their keyboard and accessibility coverage.
