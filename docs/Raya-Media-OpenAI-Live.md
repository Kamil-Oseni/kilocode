# OpenAI GPT-Live in Raya's media frontend

ChatGPT 2026-09-28: This is a Go media-frontend source contract. It does not replace the installed extension's voice route, deploy the service, or prove real microphone, SFU, browser playback or acoustic behavior.

The adapter uses the [GPT-Live primary WebSocket contract](https://developers.openai.com/api/docs/guides/voice-websockets). GPT-Live and Realtime are distinct protocols. The requested model remains `gpt-live-1`; this route must never silently select Qwen or a Realtime model.

## Versioned selection

`wire.Start.version = 2` enables explicit `engine.provider`. Supported values are `openai-live` and `qwen-realtime`. A version-two request with model `gpt-live-1` and no provider selects `openai-live`. Legacy version-zero requests without an explicit provider retain the existing Qwen route. Unknown versions/providers, incompatible Live models, and Live requests through a room driver without audio-rate authority fail before provider or room allocation. Version-two start requests are independent of version-three playback receipts.

The Live room driver must bind the exact authorized client and 24 kHz decoder rate before subscription callbacks run. The session validates every input frame as 480 mono PCM16 samples, including silence. It bypasses the legacy local speech gate and manual interruption path; Live owns continuous endpointing and native interruption. The Qwen session retains its existing behavior.

## Provider and media boundaries

The trusted service authenticates to `wss://api.openai.com/v1/live/sessions`, sends `session.start`, and waits for matching resolved session/model/audio configuration. It requests `store: false`, mono PCM16 at 24 kHz and a configured voice. Keys are not placed in query parameters or forwarded as transcript content. Redirects and foreign provider endpoints are refused; explicit loopback WebSocket endpoints exist for local conformance tests.

Input uses `session.input_audio.append`. Output uses `session.output_audio.delta` through Raya's bounded, owned 20 ms media clock. A partial PCM sample retains at most one byte across deltas. Capacity exhaustion or malformed data closes the stream; uncertain input is never automatically replayed.

Live primary output carries no provider audio item, response boundary or audio-done event. Its stream identity and sample offsets are local attribution only. The adapter emits no invented turn or final marker, and cannot establish speech completion from transcript timestamps, backend response completion, silence or arrival time. Manual commit and exact measured-playout truncation are explicitly unsupported.

## Context, closure and integration still required

Generic context append commands keep private receipt identifiers in bounded local records and use separate random wire correlation IDs. Only their text reaches provider content; generic task call identifiers are not Live delegation identifiers. An exact appended acknowledgement means acceptance, never that the content was spoken or heard. Unknown, expired or duplicate attempts cannot resend. Local accepted-context snapshots are not provider checkpoints, and delegation results cannot be replayed through generic prefill.

Stop fences media/input immediately. An independently owned control reader permits one bounded `session.close` exchange after parent cancellation. Only a validated final `session.closed` resource with final usage confirms provider closure; a timeout or lost response remains unconfirmed. Resource ownership cannot be replaced as if failed cleanup succeeded.

The production extension-to-MF bridge still needs version-two provider selection, trusted key binding, raw Live transcript/delegation correlation and exact backend result routing. Generic context injection is not a complete Live delegation implementation. Final provider usage is not a playback receipt. Real CGO Opus build, continuous microphone pacing, SFU frame attribution, decoded/render/device-output receipts, native interruption, disconnect/restart and prolonged-resource tests remain release gates. Do not mark the full voice requirement Verified from loopback or controlled-room tests.
