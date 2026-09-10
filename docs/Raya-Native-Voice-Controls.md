# Native voice controls

OpenAI native voice now exposes microphone mute, Stop speaking, and End voice in the actual composer. Stop work remains the explicit parent-work cancellation action.

| Action | Behavior |
|---|---|
| Mute microphone | Disable the existing microphone track without ending voice or admitted work. |
| Unmute microphone | Enable that same live microphone track. |
| Stop speaking | Immediately mute local playback for the current output, ask the host to cancel its active response and clear its output buffer, and allow later speech after the interrupted output is confirmed stopped or cleared. |
| End voice | Release voice media and the voice binding without aborting admitted parent work. |
| Stop work | Preserve the existing explicit session-abort behavior. |

Speech interruption is correlated to the current response and an owned event ID. Only the matching expected cancellation-race error is nonfatal; unrelated errors still surface. A later or malformed output-start event cannot unmute the interrupted output before clearance. Missing clearance produces a notice after five seconds rather than silently resuming potentially stale audio.

The composer also exposes deliberate image selection and sharing. Selection alone starts neither sharing nor work. PNG, JPEG, and WebP sources are bounded to 8 MiB, decoded with a pixel bound, and converted to JPEG at no more than 1600 pixels on the longest side and 256 KiB. The UI displays a preview and pending, shared, failed, or unknown status. Every attempted image ID is immutable: retry requires choosing an image again, including after failure. Late acknowledgements and image decoding after voice ends cannot revive that context. The visible retention notice explains that shared images go to OpenAI, remain with voice/work context, and are not deleted by End voice.

## Verification

- `tests/fixtures/openai-voice.mjs`: 31 assertions against the actual native transport using local WebRTC peers and synthetic audio, including track ownership, interruption clearance, exact error correlation, late setup cleanup, and later output recovery.
- `tests/unit/voice-interruption.test.ts` and `tests/unit/voice-images.test.ts`: 2 tests and 14 assertions for error ownership, acknowledgement correlation, and immutable image outcomes.
- `tests/fixtures/native-voice-controls.mjs`: actual VoiceProvider and composer in Chromium, at 360-pixel width in light and dark themes. The media boundary is controlled by the fixture. Both cases verify controls preserve admitted work, explicit Stop work still aborts, source validation and resizing, failed-image no replay, stale acknowledgement/decode fences, visible retention, and no horizontal overflow.
- Retained and visually inspected screenshots: `.tmp/native-voice-controls-light.png` and `.tmp/native-voice-controls-dark.png`.
- The host broker has separate local HTTP/WebSocket tests for targeted cancellation and image acknowledgement. Central extension type, lint, and integration checks are coordinated with the checkpoint build.

This verification does not measure acoustic latency or exercise a paid OpenAI call. Device selection, reconnect transcript reconstruction, narration scheduling, and the architecture document's broader service topology remain separate work.
