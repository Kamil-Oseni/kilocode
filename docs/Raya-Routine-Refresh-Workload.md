# Routine refresh workload

This EN-14 slice bounds routine refresh amplification in the extension. It does not establish a general streaming, rendering, memory-growth or reconnect performance budget.

The existing server APIs provide the roster with schedule/execution previews, role templates, and up to 50 recorded runs per routine. The roster does not include the latest result or complete run history. Each complete refresh therefore still performs **N + 2 HTTP reads** for N routines. No aggregate endpoint or server cache is introduced.

## Admission and ownership

Each provider owns one refresh coordinator. At most one refresh runs and one trailing invalidation is retained; a burst does not create a refresh queue. The initial roster/template reads run together, followed by sequential history reads. Each cycle has a 30-second deadline. A timed-out cycle reports incomplete information instead of silently claiming success.

Reads are owned by the actual SDK client object, connection generation and workspace directory. Changing ownership aborts obsolete reads and fences subsequent replies. Disposal cancels the coordinator. Replacing a client at the same server URL does not preserve ownership.

The main view has a mount/scope identity and each refresh has a monotonic cycle identity. Output-review comparisons retain their own request IDs while sharing the same reads. Up to 32 distinct pending request IDs are retained; excess requests receive a retryable error rather than silently losing acknowledgment. Repeated requests with the same ID use one slot.

Routine mutations are never queued or replayed by this coordinator. A successful mutation acknowledgment is posted separately before scheduling its authoritative read. Refresh failure does not turn a saved mutation into an unsaved operation.

## Partial results

Roster arrival does not mean history refresh is complete. Each successful history replaces that routine's prior history. An individual failed history retains its previous data, displays an explicit stale-history message, and does not prevent other routines from updating. A refresh-level failure leaves prior information visible with a stale warning. Empty history is published only after an actual successful empty response.

The Refresh routines action retries reads. Session events occurring during a refresh collapse into one trailing view invalidation. Directory changes clear the old roster/history and reject late responses; reconnect requests authoritative state again. Previously loaded history is not evidence that an interrupted run completed.

## Reproducible workload

From `packages/kilo-vscode`:

```powershell
bun test tests/unit/routine-refresh.test.ts tests/unit/routine-refresh-view.test.ts tests/unit/routines-edit-view.test.ts
```

The transport fixture uses the generated SDK and an actual local HTTP server. With 40 routines and 100 invalidations during a gated refresh, its budget is two cycles, **84 HTTP reads**, and at most two simultaneous reads. A selected failed history must not prevent the last routine from refreshing. The fixture also exercises independent client/directory/generation replacement, deadlines, retry, disposal, comparison correlation and separate mutation acknowledgment.

The rendered production RoutinesView fixture checks event coalescing, retained results on failure, explicit stale status, read-only retry, successful empty-history replacement, stale cycle rejection, workspace ownership and reconnect loading. The existing routine editor fixture guards comparison and mutation workflows.

These are deterministic request-count and state-correctness budgets, not representative production latency measurements. Large rosters remain O(N) per cycle, and backend roster previews themselves read histories. Aggregate summaries, incremental revisions, memory growth and concurrent long-session responsiveness remain separate EN-14 work.
