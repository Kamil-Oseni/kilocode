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

## Trusted bridge foundation

ChatGPT 2026-09-28 17:43 EDT: the trusted extension broker now supports explicit version-two `openai-live` selection alongside compatible Qwen selection. It loads bounded saved ordinary text under the original session/directory/server ownership and sends private credentials only between trusted local services. The webview receives its room token, never the provider key, media control capability or canonical binding secret. This foundation does not change the default direct Live UI route.

Before returning Live room credentials, the backend persists admission intent and obtains an actual canonical budget reservation. Its exact finite `maximumSeconds` must exceed 1.4 seconds and be at most 86,400 seconds; missing or inadequate allowance refuses. The extension validates and passes this allowance to Go. Go begins the wall budget before paid connection and fences input/media 1.3 seconds early for bounded finalization. Unknown startup retains the reservation; no automatic release/rebind or fabricated usage is allowed.

Authenticated callbacks bind the exact provider session/model to the original canonical task. Cumulative observations do not become final charges. Only exact final `session.closed` usage is recorded, including after ordinary MF closure. Callback identity, sequence and receipt checks refuse foreign, stale or contradictory events. Raw Live delegation currently refuses before legacy Qwen work can start; canonical caption context and task dispatch are not connected yet.

Explicit client delegation in Go records original provider delegation IDs in a bounded ledger. The authenticated `/v1/sessions/{id}/result` endpoint accepts version-one results with `delegationID`, independent `receiptID`, `kind`, `content`, `ttl` and `created`. It appends only to a known original delegation, preserves exact append acknowledgements and refuses contradictory identity reuse, expiry and unknown replay. Generic context/prefill cannot manufacture or replay delegation authority. Backend-to-result dispatch is still required.

## Context, closure and integration still required

Generic context append commands keep private receipt identifiers in bounded local records and use separate random wire correlation IDs. Only their text reaches provider content; generic task call identifiers are not Live delegation identifiers. An exact appended acknowledgement means acceptance, never that the content was spoken or heard. Unknown, expired or duplicate attempts cannot resend. Local accepted-context snapshots are not provider checkpoints, and delegation results cannot be replayed through generic prefill.

Stop fences media/input immediately. An independently owned control reader permits one bounded `session.close` exchange after parent cancellation. Only a validated final `session.closed` resource with final usage confirms provider closure; a timeout or lost response remains unconfirmed. Resource ownership cannot be replaced as if failed cleanup succeeded.

The default Live UI path must remain unchanged until canonical caption context, permission-governed task admission and exact backend result routing are connected. Generic context injection is not a complete Live delegation implementation. A setup audit also found that paid engine startup precedes room setup and the app callback owner: failed Open/room Join can discard exact startup/final receipts or release an unknown setup claim. Budget expiry during Join can briefly admit an already closed engine. Next implement a dedicated authenticated setup-settlement path that records exact usage while keeping public status failed/closed and admitting no work. Preserve immutable receipt intent before accounting-only bind/close, refuse changed identity, and retain missing final usage as unknown. Typed Open failures must preserve observed receipts/cleanup state; setup and room Join must share the reserved deadline, with active-provider state checked before readiness. Reordering Join alone does not repair startup-timeout receipt loss. See the handoff for the source boundaries and adverse journeys.

Final provider usage is not a playback receipt. Real CGO Opus build, continuous microphone pacing, SFU frame attribution, decoded/render/device-output receipts, native interruption, disconnect/restart and prolonged-resource tests remain release gates. Do not mark the full voice requirement Verified from loopback or controlled-room tests.
