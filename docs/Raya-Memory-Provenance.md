# Recorded memory context in the transcript

This UX-04 slice exposes existing persisted memory receipts in the assistant transcript. It does not reconstruct the full prompt or infer which information caused an answer. Installation and validation outcomes are recorded separately in the implementation progress log.

## What the disclosure means

An empty, synthetic, ignored text part with valid `metadata.kiloMemory` is a receipt. Startup receipts appear as **Memory prepared for this step**. Recall receipts appear as **Memory retrieved during this step**. Ordinary text with a coincidental metadata key continues to render as ordinary text.

The collapsed disclosure shows the recorded item count. Expanding it reveals bounded source filenames and estimated token count. It never renders the `items` field, recalled snippets, prompt text or a memory document's content, including when verbose backend metadata happens to contain them. Sources and scope strings are display-only text, without links or filesystem actions.

New receipts may contain `captured` and `scope: { directory, project }`. The preparation or retrieval time is not the original source's modification time and does not prove that a fact is still current. Startup time belongs to the actual prepared block; reusing the session's pinned block preserves that time. Startup scope identifies the execution directory and the verified canonical project that supplied the memory store. Recall scope remains unrecorded when the tool metadata cannot prove it. Legacy receipts explicitly show missing time and scope rather than substituting the current workspace or live memory status.

The server persists the receipt after an assistant step completes processing. A recall may happen during that step's tool execution. A later recall can replace the cache's startup or earlier recall marker, so this is not an exhaustive list of context supplied to the model. A receipt is not proof of model consumption, answer reliance, factual correctness or user acceptance.

## Historical ownership and correction

These disclosures are read-only. The existing memory inspector and `/memory` workflow remain available after the user opens and verifies the intended project. A transcript receipt does not authorize opening a path from metadata or correcting the current workspace's memory.

The current host memory workflow resolves through `getProjectDirectory(sessionID)`, which can use a panel override or a workspace fallback. That is useful for current project settings but insufficient proof for a historical receipt, an imported transcript or an ambiguous multi-project session. This slice deliberately does not attach an automatic inspect/correct action to that resolver. A future action must resolve the owning session and receipt authoritatively, refuse ambiguous or unavailable ownership, and use the proven directory without fallback.

## Rendering and limits

- The production `AssistantMessage` component renders a receipt at its own part position. Both virtualized transcript chunks and the older turn renderer use the same recognition rule. Receipts remain separate from collapsed tool groups and are not copied as answer prose.
- The decoder requires a known receipt kind. Provided counts must be finite nonnegative safe integers; absent legacy item counts or token estimates are explicitly unrecorded, never inferred from source filenames. It recognizes the legacy `sources` field but ignores unknown marker kinds. Malformed scope and timestamps remain unrecorded.
- Display inspects at most five source candidates, deduplicates them, and clips long labels. Source filenames are limited to 160 characters plus an ellipsis, scope labels to 400 characters plus an ellipsis. This display limit does not imply there were only five underlying sources.
- No new memory fetch, telemetry event, command dispatch, file open or mutation is triggered by expanding a receipt.

UX-04 still includes broader work: authoritative correction actions, provenance for attached and indexed context, and indexing freshness/status at the point of use. This receipt disclosure does not claim to finish those requirements.

## Validation targets

`packages/kilo-vscode/tests/unit/memory-provenance.test.ts` covers decoding, malformed metadata, legacy fields and content/display limits. `tests/unit/memory-provenance-view.test.ts` renders the actual assistant component through real transcript chunking with persisted parts, tests startup/recall copy and accessible disclosure state, and verifies no duplicate receipts, no recalled-content disclosure and no unsafe host actions. Backend memory integration tests cover preparation-time retention and verified scope capture.
