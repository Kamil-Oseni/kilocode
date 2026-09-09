# Raya review mutation contract

This documents the implemented revision preconditions for the existing session Keep/Undo endpoints. Remaining integration work is tracked in [Raya implementation progress](Raya-Implementation-Progress.md).

## Request and response

`POST /session/:sessionID/keep_changes` and `POST /session/:sessionID/discard_changes` accept an optional `expected` object alongside the existing `files` array. Each key is a reviewed file path and each value is its revision fingerprint. The generated SDK exposes this field.

Requests may also carry `requestID` (1–128 characters). When supplied it requires `expected` and identifies one logical review attempt within the session. The updated extension supplies this ID and reuses it for a retry of the same action, scope, revision and active-session generation.

- Omitting `files` means the reviewed session change set. `expected` must cover that whole current set.
- Providing `files` means that exact subset; `expected` must cover the subset. An explicitly empty subset is rejected when preconditions are supplied.
- A successful response contains the updated session. The extension waits for that response before dismissing review controls.
- A changed revision, changed file set, missing requested file, or ambiguous path alias produces HTTP `409` with `_tag: "ReviewConflict"` and a message requesting a review refresh. The operation has not changed files or accepted boundaries at that point.
- Omitting `expected` preserves the old API behavior for existing callers. The updated editor and chat review controls supply it. Compatibility with older remote backends that ignore unknown request fields is not yet negotiated; use the matching rebuilt backend for this contract.

## Revision identity

Content-only responses retain version 1: the lowercase hexadecimal SHA-256 digest of the UTF-8 encoding of:

```ts
JSON.stringify([diff.file, diff.patch, diff.before, diff.after, diff.status])
```

Session-wide review responses with a persisted patch event include an opaque `generation`. Those responses use version 2:

```ts
JSON.stringify(["v2", diff.file, diff.patch, diff.before, diff.after, diff.status, diff.generation])
```

The backend derives the generation from the latest persisted message and patch-part identity for each file across the selected session subtree. It remains stable across reads and restarts, and a later patch event changes it even if the patch text is identical. The generation participates in editor commands, chat review identity, expected backend revisions, and the persisted retry journal's scope. A later edit therefore cannot reuse an abandoned attempt solely because its contents match. Keep boundaries continue to fence completed message IDs.

Absent tuple members serialize as JSON `null`. Paths and content are hashed exactly as returned by `session.diff`; clients must not reformat patch text before hashing. Scope matching separately resolves relative paths against the session directory and handles Windows case aliases. Duplicate canonical paths are rejected. Older content-only responses remain version 1; an older client that does not understand generation metadata needs a matching client update to submit guarded actions to this backend.

The extension and backend implementations are checked against each other with ordinary, Unicode, NUL-containing, and deletion examples. The fingerprint describes the returned review content; it is not an authentication credential or proof of filesystem ownership.

## Scope and acknowledgement

The backend compares preconditions while holding its shared review lifecycle semaphore. Keep, file Undo, conversation revert/redo, checkpoint cleanup, and the final session-state deletion step share this semaphore within the backend's service graph. Concurrent per-file Keeps therefore cannot overwrite each other's stored accepted boundaries, and final deletion cannot remove session state during a review mutation.

Deletion cancels background work before acquiring the gate, because cancellation can wait for checkpoint cleanup that also needs it. Recursive child deletion acquires the gate separately for each final deletion, rather than holding it across recursion or job shutdown. This does not make an entire subtree deletion atomic, coordinate independent backend processes, or serialize ordinary agent writes. Receipt removal still requires an explicit lifecycle/reconciliation design.

Verified file paths are resolved to exact absolute paths before mutation, avoiding the older filename-suffix filter selecting another file. Supplying a full reviewed set to Undo all retains its original-boundary behavior; a per-file Undo still restores the most recent unaccepted edit in that file. Neither operation may cross a persisted kept boundary.

The editor binds commands to session and revision. Chat binds acknowledgements to request ID, session, displayed revision and agent-turn generation. Failure retains review controls and prompts an authoritative refresh. A late success does not dismiss a newer displayed revision.

Inline transcript Keep file and Undo file use this same acknowledged request flow with an exact single-file scope. They do not hide controls merely on click. Per-file acceptance survives lazy transcript mounting and unrelated file changes; a different revision reopens that file. Host-supplied path aliases reconcile absolute editor/tool paths with relative review paths.

Session-wide diff responses include optional `reviewed` metadata: the accepted content fingerprint, an empty string for pending review, or an omitted field when metadata is unavailable (including older backends). The backend reconstructs this from persisted Keep boundaries in the requested session, its descendants, and its ancestor chain, together with the latest recorded patch messages in the selected subtree. Boundary paths are resolved in their owning session's directory and merged by the latest accepted message for each file. Ancestor traversal does not expand into unrelated sibling sessions. Missing boundaries mean pending review; corrupt or unreadable boundaries fail the read rather than inventing acceptance. A later patch beyond the boundary revokes acceptance. Message-specific and full-content detail responses remain content-only.

Editor and chat refreshes restore matching accepted revisions from this metadata, including a freshly initialized view. Explicit pending metadata revokes a local dismissal; missing metadata preserves the older-backend fallback. Undo uses the same merged boundaries in both directions: a child Keep protects work from parent Undo, and a parent Keep protects work from direct child Undo. Later edits in the selected session remain undoable down to that accepted boundary. This restores Keep state without treating chat mounting as persistence. Recovering historical inline Undo dismissals after the file disappears from the diff and measuring the additional history reads on large session trees remain open.

## Verification and remaining guarantees

### Retry receipts

The backend writes a pending receipt before executing an identified request and marks it complete only after the mutation and its persistence return successfully. The receipt binds the action, exact submitted file scope, and sorted expected revisions. IDs are hashed before becoming storage path components. A matching completed receipt returns current session information without repeating Keep or Undo, even if files have changed afterward. Reusing an ID with different parameters returns `409 ReviewConflict`.

Before reading or creating an identified request's receipt, the backend verifies that its session still exists. This check runs inside the shared lifecycle gate, so deletion in that backend cannot interleave between the existence check and review completion. A request arriving after deletion fails without creating a new orphan receipt. Independent backend processes and receipts left by earlier completed sessions still require separate lifecycle handling.

Known busy/revision rejections happen before file mutation and remove the pending receipt, allowing a corrected retry. An unexpected failure leaves the pending receipt intact: retry returns an explicit uncertain-outcome conflict and performs no mutation. Malformed receipts fail closed. Editor and chat preserve the actionable backend conflict message.

Receipts are serialized under the existing backend checkpoint semaphore and persisted in local storage. A claim now publishes a fully written, file-synced temporary receipt with an exclusive hard link; a competing process cannot replace that claim. Completion uses a same-directory atomic rename instead of truncating the visible receipt. Temporary files are scoped and removed after normal completion. The filesystem must support these operations; an unsupported operation fails before authorizing a mutation rather than falling back to an unsafe copy.

Tests cover independent OS-process claims and readers racing completion publication. This protects the same request ID across processes; different request IDs still do not share a cross-process workspace mutation lock. A transaction spanning receipts/files/boundary storage, power-loss durability of directory metadata, pending-receipt reconciliation, and receipt retention/deletion (including orphaned temporary files after a crash) remain release gates. A pending record must not be interpreted as proof that the original operation did or did not complete.

The extension saves attempt IDs in workspace state before dispatch. The journal key hashes session, directory, action, submitted file scope, and expected revisions; each new entry stores the backend ID and a hashed owning session. It contains no patch text. Writes are serialized within the host. On an explicit matching retry after restart, the host reuses the saved backend ID. A recovered acknowledgement triggers authoritative state refresh instead of directly dismissing current controls. Corrupt journal data, mismatched ownership, or persistence failure prevents dispatch. Dirty buffers are checked again after the asynchronous journal write.

Backend-confirmed session deletion prunes matching owned journal entries and pending delivery callbacks through the host's existing deletion handler, including deletion events received from another client. Other sessions remain intact. Legacy string entries acquire ownership when a matching retry identifies their scope; unattributable legacy entries are retained. Cleanup failures are logged and leave persisted entries available. Offline missed deletion events, unmatched legacy entries, and backend receipt deletion still require reconciliation.

Chat success retains the journal entry until the requesting view processes the result and sends `editReviewAcknowledged` with the matching session and frontend request ID. The host only permits cleanup for a result it successfully obtained from the backend; unrelated acknowledgements do nothing. A dropped result or host restart before delivery therefore leaves the original backend ID recoverable. Cleanup failure retains the entry for a later retry. An editor command applies its acknowledgement before cleanup and preserves the journal if disposed before success arrives.

Entries from abandoned or uncertain attempts currently have no reconciliation or retention policy. Workspace-state persistence does not coordinate different extension hosts. Receipt delivery does not persist historical Undo presentation. Tests exercise file-backed reopen, concurrent local claims, failed persistence, recovered SDK transport, mismatched delivery acknowledgements, and editor disposal; they do not establish end-to-end crash recovery in a live VS Code process. Review generations distinguish later recorded patch events; legacy diffs without a persisted patch event retain content-only identity and cannot provide that guarantee.

Real session, storage and snapshot tests cover stale content rejection, concurrent acceptance, corrupt kept-boundary failure, successful matching requests and original-boundary Undo all. HTTP tests verify the typed `409` response. SDK transport tests verify that editor and chat requests actually contain the preconditions.

Requests with `expected` also compare the selected live files against the latest completed agent snapshots. The check reads immutable Git tree/blob identities rather than trusting the snapshot staging index. Missing snapshots, unreadable files, recreated deleted files, changed file types, and redirected parent directories fail closed. Git attributes are applied when hashing regular files; symlinks are compared by their link targets. Active descendant sessions also prevent guarded review mutations.

Undo repeats this check while holding the snapshot restore lock, before writing any files. A conflict at this point skips rollback: restoring a previously captured backup would itself overwrite a newer manual edit. Actual restore failures retain the existing recovery path.

These checks narrow the race with external writes; they are not a filesystem transaction. Another process can still change a file after its last check, snapshots can already include external edits captured during an agent turn, and separate backend processes do not share these locks. Unsaved editor buffers are not visible to the backend. Old callers without `expected` retain their prior behavior. Cross-process coordination, remote capability negotiation, durable handling of uncertain network outcomes, performance validation on large change sets, and live extension interaction validation remain open before the audit's review findings can be closed.

The extension checks open local file documents before issuing Keep or Undo. A dirty buffer in the selected file set blocks the request and asks the user to save or revert that buffer. Bulk guarded requests check the full declared review set; legacy bulk requests check the session directory. The extension does not implicitly save or discard buffers, and unrelated dirty files do not block scoped review. This preflight covers documents visible to the current extension host, using resolved paths and Windows case normalization. It cannot prevent typing after dispatch or inspect another editor process, and alternate symlink paths and remote document schemes still need explicit integration coverage. Saving a manual edit can then trigger the backend's saved-file conflict check; saving is not an instruction to overwrite that edit.

## Review history workload

Generation projection reads persisted patch rows directly through the injected database service. It selects the requested session's patch events and validates their file lists, without hydrating transcript messages or tool outputs. Reads see subsequent patch removals immediately; there is no cache to invalidate. Malformed patch metadata fails closed. Session-tree and Keep-boundary traversal retain their existing scope.

The regression fixture in `packages/opencode/test/kilocode/session/review-history.test.ts` creates 128 persisted messages with two patch events. The full transcript serializes to 8,648,941 bytes; the selected patch metadata serializes to 285 bytes. These are representation sizes, not a heap-allocation measurement. Five-read local medians were 18.11 ms before the change and 15.78 ms afterward; a subsequent concurrent verification run measured 22.81 ms. These observations do not establish a latency improvement or a production performance budget.

SQLite still examines session rows to filter patch events, and patch-heavy histories and large descendant trees can require more work. Query indexing, peak heap, concurrent sessions, rendered responsiveness, and reconnect workloads still need broader measurement before EN-14 is complete. The test asserts identity, isolation, deletion visibility, malformed-data rejection and compact metadata; it deliberately does not enforce a machine-dependent timing threshold.

## Runtime stores inside the workspace

Snapshots exclude Raya's data, cache and state directories when those stores are descendants of the selected worktree. The snapshot store is also excluded when working directly inside the data directory. Exclusions are private to the snapshot Git repository; they do not edit the user's ignore files. Literal paths with spaces or Git-ignore metacharacters are escaped, and similarly named sibling directories remain ordinary workspace content.

Before capturing another snapshot, existing runtime entries are removed from the snapshot index with `git rm --cached`. Their live files are preserved. New snapshots therefore stop recursively capturing snapshot objects, databases and runtime logs. Whole-snapshot restoration refuses legacy trees containing protected runtime entries, and selective reversion refuses requests targeting those stores before changing any workspace file. A rejected old snapshot needs a clean checkpoint or manual recovery of the intended user files; rejection does not erase the saved tree.

A real CLI multi-tool regression reproduced the original failure with the test home as its workspace and runtime state nested beneath it. Three todo calls had completed before repeated snapshot initialization exhausted the 90-second run limit; saved file diffs included the snapshot repository's own object database. With the exclusions applied, all five todo updates and the final response completed within the same limit. A separate isolated snapshot regression covers repeated stable captures, a runtime path containing brackets and spaces, sibling preservation, legacy indexed entries and blocked restoration of live runtime data.
