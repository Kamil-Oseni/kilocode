# Native voice transcript reconciliation

The native OpenAI composer now treats transcript generation and audio playback as different facts. Partial output is labelled as generated text; a final transcript still says playback is unverified. Input partials are also labelled and visually distinguished. Nothing in this projection submits text, starts work, cancels work, or writes an authoritative conversation transcript.

Stop speaking immediately hides generated output for that response and shows a provisional interruption notice. Native user-speech events apply the same conservative display change to the currently playing response. A provider `conversation.item.truncated` event confirms the exact assistant item/content index and records its `audio_end_ms`. The UI reports this as a provider-confirmed cutoff, not a locally measured playout cursor or a statement of which words were heard.

OpenAI documents that WebRTC manages interruption truncation and that clearing the output buffer also truncates conversation context. It also explicitly states that the API cannot precisely align transcript words with audio and does not provide a corrected truncated transcript. We therefore hide the interrupted text instead of calculating a character prefix from milliseconds. See [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations#interruption-and-truncation) and the [server event reference](https://developers.openai.com/api/reference/resources/realtime/server-events).

The verified truncation event fields are `type: "conversation.item.truncated"`, `event_id`, `item_id`, `content_index`, and `audio_end_ms`. Item IDs and finite nonnegative integer indices/offsets are validated before changing the projection. The cutoff is attached to the exact content part; it cannot suppress another content part or an input transcript. Repeated confirmations cannot lengthen a previously confirmed cutoff.

## Ordering and bounds

The projection retains completed display records so an authoritative truncation can revise them after generation finishes. It retains interruption markers even when truncation precedes the first text event. Failed, incomplete, and cancelled generation keep their terminal reasons and display an unavailable-text explanation instead of promising a future truncation acknowledgement. Response cancellation remains separate from generation completion: a late completed event cannot restore cancelled output. Delta or done events for an interrupted content part cannot restore its text.

Each admitted display item has a sequence. Older partial completions and interruption confirmations update their own state without replacing the newer visible item. The VoiceProvider also rejects a transcript with an older display sequence. Native transport ownership fences events after voice ends or a task changes, and each new call receives a fresh projection.

The display has independent limits: 8192 characters per text, 256 item/content records, 256 response terminal/interruption records, and 8192 remembered transcript event IDs per call. Exhausting correlation capacity clears the display and explicitly says that the transcript display limit was reached while voice continues. It does not evict interruption markers and then accept resurrected text. Starting another voice call resets display capacity. Character shortening uses the existing display-bound flag and is not confused with an audio interruption.

These records are in-memory UI state. This slice does not implement architecture Part VII's persisted authoritative reconstruction, a measured playout timeline, a recovered heard-word transcript, reconnect continuity, or memory/audit consumption of voice text.

## Verification

- Production `NativeProjection`: 8 tests, 47 assertions for local/provisional hiding, done-then-truncated correction, pre-transcript markers, exact content indices, cancellation retention, newer-item selection, malformed events, failed/incomplete terminal reasons, duplicate deltas, and all correlation capacity limits.
- Actual local WebRTC transport fixture: 35 assertions, including immediate hiding, provider cutoff confirmation, VAD interruption, old confirmation ordering, and preserved live media. Audio is synthetic and no paid provider call is made.
- Actual VoiceProvider and composer fixture: light and dark themes at 360-pixel width. It verifies generated/partial labels, local interruption, confirmed offsets including zero, VAD, late-event selection, display exhaustion, old-call fences, and preservation of admitted work. The fixture controls the media boundary while executing production projection and transport event handling.
- The same composer cases verify the separately implemented voice usage meter: foreign request/session rejection, token and duration summaries (including 2.75 seconds displayed as 2.8s), last-call summary after End voice, reset on a new call, incomplete persistence status, and hiding after a parent-task switch.
- Screenshots `.tmp/native-transcript-light.png` and `.tmp/native-transcript-dark.png` were retained and visually inspected; confirmed interruption and expanded usage details wrap without horizontal overflow.

Scoped ESLint passed. Central types, guards and the integration build are coordinated by the checkpoint owner. This fixture coverage does not establish acoustic interruption latency or an at-the-ear playout measurement.
