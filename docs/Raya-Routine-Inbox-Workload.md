# Routine inbox page budget

This RDM-06 slice bounds conversation paging. It does not establish a general rendering, memory-growth or reconnect performance budget.

Each conversation page returns at most **50** persisted messages. A `limit` below 1 or above 50 is refused. The default page size is 50. A page that still has older messages includes a `next` cursor; the following page uses that cursor and does not repeat identities from the previous page.

The host does not request a larger page. Earlier messages are loaded only when the reader asks for them.

## Reproducible workload

From `packages/opencode`:

```powershell
bun test ./test/kilocode/task/inbox.test.ts ./test/kilocode/server/httpapi-routine-inbox.test.ts --timeout 60000
```

The in-memory inbox fixture publishes 60 reports for one worker. The first page has 50 messages and a cursor. The second page has the remaining 10 and no further cursor. The 60 sources are unique. Limits 0 and 51 fail. The HTTP fixture creates one paused worker and checks that `limit=51` and `limit=0` return 400 while the default page succeeds with an empty transcript.

These are deterministic page-size and request-correctness budgets, not representative production latency measurements. Roster refresh remains a separate EN-14 workload.
