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

Authenticated callbacks bind the exact provider session/model to the original canonical task. Cumulative observations do not become final charges. Only exact final `session.closed` usage is recorded, including after ordinary MF closure. Callback identity, sequence and receipt checks refuse foreign, stale or contradictory events. Canonical caption/delegation routing now uses the original parent task through its existing runtime boundary; it never dispatches Live work through legacy Qwen.

Explicit client delegation in Go records original provider delegation IDs in a bounded ledger. The authenticated `/v1/sessions/{id}/result` endpoint retains version-one compatibility and adds version-two requests with `delegationID`, independent `receiptID`, `kind`, `content`, `ttl` and `created`. Version-two acknowledgements include the exact session/delegation/receipt IDs, `accepted: true` and `played: false`. It appends only to a known original delegation and refuses contradictory identity reuse, expiry and unknown replay. Generic context/prefill cannot manufacture or replay delegation authority.

The backend persists bounded version-one caption and delegation ledgers before canonical admission or result delivery. Provider IDs remain separate from canonical task IDs. Imperfect captions are context evidence, never invented completed speech turns; client-correlated fragments alone cannot authorize work. One scope-owned collector retains the full canonical result in chat and sends only a bounded private-ID-filtered excerpt. Result offers persist before the single authenticated HTTP attempt. Strict exact acknowledgements confirm acceptance; lost, malformed or foreign responses remain unknown without replay. Network delivery runs outside the caption gate, and Stop aborts owned delivery while retaining late task results. Cache ownership is bounded to 256 entries and cannot evict active work.

## Context, closure and integration still required

Generic context append commands keep private receipt identifiers in bounded local records and use separate random wire correlation IDs. Only their text reaches provider content; generic task call identifiers are not Live delegation identifiers. An exact appended acknowledgement means acceptance, never that the content was spoken or heard. Unknown, expired or duplicate attempts cannot resend. Local accepted-context snapshots are not provider checkpoints, and delegation results cannot be replayed through generic prefill.

Stop fences media/input immediately. An independently owned control reader permits one bounded `session.close` exchange after parent cancellation. Only a validated final `session.closed` resource with final usage confirms provider closure; a timeout or lost response remains unconfirmed. Resource ownership cannot be replaced as if failed cleanup succeeded.

ChatGPT 2026-09-28 18:43 EDT: failed setup now reports a dedicated version-one `session.setup.closed` event through the original authenticated callback. Its exact remote provider identity and validated startup event/model are required; confirmed final event/model/reason/usage is optional. Immutable intent persists before accounting-only canonical binding, immediate closure and exact duration recording. Public status remains failed/closed; settlement after Stop or audited goal completion cannot activate work. Missing final usage stays unknown, changed identities refuse, and identical receipt reconciliation does not duplicate charges. Strict setup HTTP transport requires the bounded literal `true` acknowledgement before release.

Typed Open failures preserve immutable observed startup/final receipts and separate connection-attempt/local-cleanup truth. Definite pre-Dial refusal releases safely; paid connection uncertainty retains ownership. Manager initializes the reporter before Open, shares a reserved deadline across Open and room Join, and checks current provider readiness immediately before returning credentials. Failure cleanup uses a fresh bounded callback context; missing receipts, failed acceptance or unknown cleanup block replacement and never redial automatically. Actual loopback tests cover late startup ACK after cancellation, failed Join, held-Join budget expiry, callback refusal/malformed acknowledgement, unknown final usage and no replay. Production provider/SFU/acoustic behavior remains unproven.

The default Live UI path remains unchanged. Source tests exercise actual canonical storage and loopback transports with controlled prompt execution and silent room fixtures; they do not prove installed model/tool permissions, provider behavior or audible playback. Missing fresh intent currently refuses the callback and pauses managed media. Explicit clarification/recovery must be implemented and tested before MF UI activation. See the handoff for remaining adverse journeys and production gates.

Final provider usage is not a playback receipt. Real CGO Opus build, continuous microphone pacing, SFU frame attribution, decoded/render/device-output receipts, native interruption, disconnect/restart and prolonged-resource tests remain release gates. Do not mark the full voice requirement Verified from loopback or controlled-room tests.
