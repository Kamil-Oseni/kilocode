# OpenAI voice work authority

The OpenAI voice binding uses the existing Raya parent session. It does not create another delegate session or accept arbitrary tool, model, permission, or session arguments from a function call. `raya_work` submits one text request through the normal `SessionPrompt` path, preserving the parent session's goal and permission handling.

The extension host holds a random 32-byte capability encoded as 64 lowercase hexadecimal characters. Every binding operation requires `X-Raya-Voice-Key`, in addition to the server's configured authentication. Standalone servers retain their existing optional global authentication policy. Only a SHA-256 capability hash is retained by this service. The capability and OpenAI key must never reach the webview.

## Admission and receipts

`POST /kilocode/voice/openai/session` binds a provider call ID, canonical workspace directory, parent session, request ID and server owner. Bindings expire after one hour for new admission. Repeating the same start request returns the existing binding; a changed parent, capability or request ID cannot take over that provider call.

`POST /kilocode/voice/openai/session/{id}/calls` returns a call receipt with HTTP 200. `accepted` means durable admission, not completed work. Each binding admits at most 64 calls and one pending call at a time. A function request is limited to 8,000 characters. The service persists the reserved Raya message ID and complete input before scheduling work. Repeated identical call IDs return the existing receipt; changed input is rejected. A crash between persistence and scheduling is not repaired by replay.

`GET /kilocode/voice/openai/session/{id}/calls/{callID}?generation=...` inspects the retained receipt. A new service owner cannot adopt an old binding; an unfinished old-owner call is reported as `unknown`. This is at-most-once admission, not a guarantee that external effects completed exactly once.

Results are attributed only when the runtime returns a completed assistant message belonging to the reserved parent input and session. Another turn, incomplete tool state, or interrupted execution cannot be reported as this voice call's successful result. Text is capped at 12,000 characters with an explicit shortening notice. Tool references are capped at 64 and refer to actual parts of the returned assistant message; names longer than 128 characters are omitted rather than relabelled. These references are a bounded view, not a complete history of every earlier tool message. The Raya session retains the full conversation and tool receipts.

## Ending voice and cancelling work

`DELETE /kilocode/voice/openai/session/{id}?generation=...` closes new voice admission. Already-admitted Raya work continues and can retain its final receipt. Lease expiry likewise stops new admission without cancelling a file operation. The trusted host must discard late speech/publication events from a closed generation; the backend permits read-only result reconciliation after closure.

Only `POST /kilocode/voice/openai/session/{id}/calls/{callID}/cancel` requests cancellation of the exact reserved Raya message through `TaskWorker`. It does not cancel a later typed turn. A cancellation receipt is not evidence that already-performed tool effects were reversed. Stopping speech, muting the microphone, ending voice, and cancelling Raya work remain separate controls.

The legacy Qwen/LiveKit endpoints remain separate. This service does not accept tool calls through their generic media-event ingress and does not provide an automatic provider fallback. Trusted OpenAI signaling, sideband validation, audio transport and closed-generation publication belong to the extension host.

## Validation scope

The backend fixtures exercise real Storage publication, serialized admission, the actual Runner and TaskWorker cancellation implementation, and the shipped HTTP server. Synthetic prompt responses stand in for provider generation; these fixtures do not claim a live OpenAI audio call or external tool execution.

The coordinated backend batch passed with native exit 0: 13 tests, 91 assertions, 58.39 seconds across `voice-openai.test.ts`, `task-worker.test.ts`, and `server/httpapi-voice-openai.test.ts`. Nine voice-service cases cover durable admission, deduplication, capability and scope conflicts, cancellation and abandoned waiters, closure and expiry without cancelling admitted work, restart uncertainty, message attribution, and bounded results. The shipped HTTP fixture covers configured authentication, binding capability checks, request bounds, and closed-generation refusal. The retained log is `.tmp/openai-backend-tests.log`; instance teardown emitted an indexing interruption warning after the HTTP case passed, and the native process exited successfully.
