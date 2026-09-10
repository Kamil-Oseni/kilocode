# Native OpenAI browser voice transport

`OpenAIVoice` handles browser microphone capture, native WebRTC playback, connection status and a bounded transcript display. The extension host supplies the SDP answer through a correlated exchange and owns the API key, session configuration, tools and work dispatch. The browser never receives an API credential and never submits a transcript as a work request.

The implementation follows OpenAI's [unified WebRTC connection flow](https://developers.openai.com/api/docs/guides/realtime-webrtc): a peer offer goes through the trusted host, audio uses WebRTC tracks, and server events arrive over `oai-events`. The host configures the requested [gpt-realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1). Native server VAD and WebRTC handle interruption; the browser does not emulate interruption with an independent transcription/TTS pipeline. See [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).

## Ownership and failure behavior

- Start must originate from the user's voice action. A second start while setup, playback or uncertain cleanup owns the transport is rejected.
- Start resolves after the SDP answer is installed and the peer and event channel are connected. A 30-second setup deadline includes microphone permission and host exchange.
- Stop settles pending setup and closes the microphone, remote tracks, event channel, peer and audio element. Late microphone permission or host answers cannot revive the stopped operation. Browsers cannot cancel an already-open microphone permission prompt; any track returned after Stop is immediately stopped.
- Connection, event-channel, microphone and playback failures are visible and stop local media. There is no automatic provider fallback or replay of the host exchange. Failed cleanup retains ownership until Stop can finish.
- Echo cancellation is reported only when the browser's captured track settings confirm it. Requesting the constraint alone is not evidence that it is active.

## Transcript limits

Only documented input-audio transcription and output-audio transcript events are projected. Function-call events are ignored by this client. Per-item display text is capped at 8,192 characters with an explicit truncation flag; partial item state and deduplication history are bounded. A completed transcript is not proof that audio was played, a tool ran, or a work result was accepted. Input transcription failures remain visible without fabricating transcript content.

## Validation and remaining acceptance

`bun test ./tests/unit/openai-voice.test.ts` runs the actual transport in local Chromium against a second native WebRTC peer. Synthetic `AudioContext` tracks replace only the microphone boundary. The fixture covers connection, duplicate admission, interruption/status events, bounded transcripts, ignored tool events, stop, late microphone/SDP completion and rejected setup. It uses no API key, external OpenAI call, paid request or real microphone. The local native fixture passed 22 implementation assertions. The actual `VoiceProvider` fixture passed 29 bridge/state assertions covering missing keys, stale replies, engine changes, task-navigation cleanup and no automatic fallback; its media boundaries are substituted, while the separate native fixture covers real peer connections. The legacy Qwen provider lifecycle fixture also passed. The six actual Speech settings Chromium cases passed at 320px and 760px in light, dark and high-contrast layouts, covering keyboard key save/clear, missing-key status, retained errors and absence of the legacy Test voice control when OpenAI preview is selected. Screenshots were inspected for wrapping and overflow; configured palette Axe checks are separate from forced-system-color interaction captures. Existing shared high-contrast switch styling remains a visual limitation outside the OpenAI controls.

This does not establish production OpenAI account access, a successful paid session, real microphone quality, acoustic echo cancellation, browser/VS Code microphone permission support, or interruption latency. Those require an explicit live acceptance session. Browser autoplay or device rejection is surfaced as a failure, and typed work remains available.
