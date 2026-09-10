# OpenAI voice narration and response scheduling

The extension host now schedules brief waiting speech and final-result speech through one lane. This implements a bounded part of the narration ladder in the voice architecture. It does not introduce another work session, economy-model delegation, provider fallback or a promise of live-account latency.

## Elapsed time and truthful statements

The host measures monotonic elapsed time from the single backend work submission. It stays silent before 400 ms and until it receives a validated `accepted` or `running` receipt for that call. It cannot infer an active tool, completed step, permission state or cause of delay from those statuses.

| Elapsed threshold | Eligible narration |
|---|---|
| 400 ms | A brief acknowledgement based on the admission receipt |
| 1200 ms | A short holding statement with only the known admission/running fact |
| 2500 ms | A short holding statement without an invented delay explanation |
| 5000 ms | A background notice: the user can keep talking and the work remains in their conversation |

Timers coalesce to the latest eligible rung; delayed callbacks never replay a backlog of stale acknowledgements. At five seconds the local narration state becomes background even when speech is blocked. This is a presentation transition: the work already runs asynchronously in the parent conversation. Polling and the backend's serial admission constraint continue unchanged. There are no further periodic holding messages for that call. Completion removes its unsent narration.

Narration supplies isolated factual instructions, with no conversation input or tools. The provider generates the phrasing; the host does not claim to validate every generated word or guarantee a particular language/accent. No work description or delay cause is invented to make a holding statement sound more specific.

## One speech lane

The host waits while user audio, a pending automatic VAD turn, provider generation, buffered playback or an unacknowledged host response owns the lane. Speech-stop alone does not imply that the automatic user response has finished. A final result has priority over unsent holding speech. Known old playback-stop events cannot release a newer playback gate.

Each host `response.create` carries an independent event ID and matching response metadata. Only the corresponding response clears its request; unrelated responses and errors cannot release it. Narration and final-result continuations both disable tools. Ordinary user/VAD responses retain `raya_work`. Even a malformed tool output in a correlated host-generated response is not dispatched as work.

If user speech starts while a host response is in flight, the host cancels that exact provider response and clears only its matching playback. A late host response yields to a user turn or another active response. These are audio controls; none invoke the backend task-cancellation endpoint. Ending voice, stale workspace ownership and disposal cancel local narration timers and fence later speech.

## Result delivery and uncertainty

The genuine function result is sent once, with its own item/event identity. Before requesting speech, the host requires a `conversation.item.created` acknowledgement matching the item ID, call ID and SHA-256 of the serialized result. Rejected, mismatched or unacknowledged output does not generate a continuation or repeat work. A 30-second missing-output acknowledgement is reported as unconfirmed delivery; the retained result stays in chat.

A 30-second missing response acknowledgement fences further host speech because the request may already be generating audio. This is not a provider cancellation or a backend work timeout. Matching provider errors can report a failed voice continuation without dispatching another work call. A subsequent independently delivered result may still be spoken; the failed response itself is not retried. A running provider response without a terminal event remains a speech gate rather than being assumed finished.

The provider usage observer receives raw response events before narration filtering, so any supplied usage for holding speech is observable through the separate usage receipt feature. Narration therefore has a possible provider cost; this scheduler is not a spending limit.

## Provider contract and verification

The official [Realtime conversation guide](https://developers.openai.com/api/docs/guides/realtime-conversations) documents response metadata correlation and client event IDs for errors. The [Realtime client-event reference](https://developers.openai.com/api/reference/resources/realtime/client-events) supports per-response tool suppression and responses outside the default conversation. Checked September 10, 2026; the configured model remains `gpt-realtime-2.1`.

Tests use the production scheduler with a controlled monotonic clock for threshold/race assertions and the production broker over actual loopback HTTP/WebSocket transports for integration. The combined focused batch passed 28 tests and 676 assertions in 18.64 seconds, native exit 0 (`.tmp/voice-narration-tests-final.log`), including a real five-second pending-work case. A subsequent bounded provider-ID validation regression passed with the scheduler suite: 9 tests and 51 assertions, native exit 0 (`.tmp/voice-narration-identifiers.log`). Final scoped lint exited 0 (`.tmp/voice-narration-lint-verified.log`); central package checks remain part of the checkpoint. No paid provider calls were made. Device playback, live account delivery, generated phrasing and perceived conversational quality still require live evaluation.
