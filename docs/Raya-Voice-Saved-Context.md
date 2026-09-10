# Saved conversation context for voice

`loadVoiceContext` reads the selected existing conversation through the configured SDK client. It neither creates a session nor submits a prompt, tool call or command. The caller supplies cancellation and a current-scope predicate; the host integration remains responsible for its connection, backend and selected-session ownership.

The loader reads the parent, its latest 32 messages, the session-status snapshot, and the parent again. Parent ID and workspace must match both parent reads. Cancellation or scope changes are checked around network reads and before returning. A changed revert boundary is refused. Ordinary activity changing the parent's updated time does not block voice: the bundle instead records that the source changed during reading and marks the excerpt partial.

Only ordinary user text and assistant text with a completed time and `finish: stop` are eligible. Hidden, synthetic and ignored content is excluded, including marked metadata. Tool, reasoning, image, compaction-summary, errored and unfinished assistant content is omitted. Replies to known hidden or textless user messages are excluded. Reverted turns are excluded conservatively, including the entire boundary message even if a partial message remains visible in chat. Duplicate message identities and text attributed to another session/message are refused.

The JSON bundle contains historical text as data, with an explicit instruction not to follow its old instructions or restart work. It states that unsaved voice dialogue and audio are unavailable. Its work status is only an observed `idle`, `busy`, `retry`, `offline` or `not_reported` snapshot; even `idle` is not a completion receipt. This framing is not a guarantee against prompt injection by a downstream model: the broker's permissions and work-admission path must remain authoritative.

## Bounds and limits

Each successful SDK response is streamed with a 512 KiB decoded-body limit before JSON parsing. A partial read aborts the loader's owned HTTP request and releases the reader. The whole load has a 15-second deadline and never changes the SDK client's global configuration. Redirects are refused.

The final UTF-8 bundle is at most 16 KiB. Individual message text is at most 4096 UTF-8 bytes, with explicit clipping metadata. Recent eligible messages are preferred; clipped text never splits a surrogate pair at the truncation boundary. A full 32-message page, omitted content, clipping or activity during the read marks the result partial. This is a recent excerpt rather than a complete or atomic transcript. Completed legacy assistant entries without the required finish marker are conservatively omitted.

The current SDK eagerly reads non-success response bodies before returning errors, including when `parseAs: stream` is requested. That SDK error-body path does not receive this loader's byte bound. The configured SDK transport is intentionally preserved instead of silently replacing a caller's custom fetch or installing a global interceptor. Neither the output limit nor the success-stream limit claims to bound transport-internal buffering.

## Provider handoff

Every fresh native OpenAI call loads this excerpt before creating the provider call. The host checks the current backend configuration identity as well as the selected conversation/workspace. A cancelled or changed attempt cannot transmit the returned context.

After backend binding, the trusted sideband waits for acknowledgement of its session instructions and semantic turn settings. It sends one bounded historical user text item and waits for the exact item identity, role, content type and text acknowledgement before returning the SDP answer to the webview. Unrelated, merely added, duplicated or mismatched events cannot activate the call or replay work. No `response.create` is sent for this handoff. Setup errors, disconnection, cancellation and the 20-second control deadline close the owned provider call and backend admission through the existing cleanup path.

The current [OpenAI conversation guide](https://developers.openai.com/api/docs/guides/realtime-conversations) documents text item creation separately from response generation and identifies `conversation.item.done` as a completion event. Context, image and result handoffs now recognize that completed event while preserving exact-content checks and the existing `conversation.item.created` compatibility acknowledgement. `conversation.item.added` alone is insufficient for context readiness.

This does not restore unsaved spoken dialogue, replay a previous provider session or perform a silent warm handoff. The [explicit recovery UI](Raya-Native-Voice-Recovery.md) explains that limitation before a new call and waits for both local and host cleanup confirmation.

## Verification

The fixture uses the actual generated SDK over a local HTTP server, with authenticated GET-only requests. It exercises ordinary historical instructions, filtering and hidden families, UTF-8 clipping, parent/directory/revert changes, concurrent work activity, missing status, wrong text attribution, oversized input and cancellation of an actual delayed request. Initial cancellation-fixture sequencing waited in a rejection matcher before issuing abort; that failure is preserved in `.tmp/voice-context-tests.log`. The corrected fixture issues cancellation before inspecting the settled rejection.

Final context tests passed 9 tests and 150 assertions in 1.103 seconds, native exit 0 (`.tmp/voice-context-tests-final.log`). Final scoped lint exited 0 (`.tmp/voice-context-lint-verified.log`). No paid provider calls or device capture were used. Provider injection and acknowledgement are owned by the separate host integration.
