# Native voice usage receipts

Raya now observes OpenAI response and transcription usage on the trusted sideband, independently of workspace work. The composer shows the current connection's reported token counts and any reported transcription duration. Its last summary remains visible after End voice in the same parent conversation; another call resets it, and switching conversations hides it.

The response and transcription paths use distinct model identities and receipt keys. Repeated provider events do not add their counts twice. Cached input is retained as a breakdown of input, not added to total input again. Duration reports retain provider seconds without inventing token counts. Failed or cancelled responses can still carry usage, so observation happens before speech/work filtering. These event sources follow OpenAI's [Realtime cost documentation](https://developers.openai.com/api/docs/guides/realtime-costs) and [server event schema](https://developers.openai.com/api/reference/resources/realtime/server-events). The configured [GPT-Live-Transcribe model](https://developers.openai.com/api/docs/models/gpt-live-transcribe) has duration-based pricing; this meter does not convert its reports into an invoice estimate.

## Retention and integrity

`POST /kilocode/voice/openai/session/:id/usage` retains a normalized receipt under the binding's capability, generation, directory and live owner. The body contains the generation and a receipt with provider identity, kind, model, availability and either validated counts or transcription seconds. No audio, transcript text, image bytes or credentials are retained in usage receipts.

One binding retains at most 512 receipts. Identical retries are idempotent; a reused identity with changed counts is a conflict. Input/output totals, cache bounds and modality subcounts are checked before storage. Missing and malformed usage are retained as explicit states with no fabricated measured counts. Reads and writes validate retained receipts and their identity-derived index keys, rejecting damaged or duplicated indexes. Reads remain available after voice closure or server restart through `GET` on the same protected path.

Writes run in a bounded, asynchronous host queue. They neither block audio nor repeat workspace work. A failed display observer is isolated and logged without exposing receipt content. Ending voice stops queued writes and reports remaining unconfirmed saves. A failed write, conflicting duplicate, observation limit or unresolved response leaves the meter explicitly incomplete. The provider may have delivered or the backend may have saved a receipt whose acknowledgement was lost; this is not treated as confirmed nonexecution or automatically replayed.

## Limits and remaining work

This is an observed connection meter, not a complete bill. Events lost before receipt cannot be reconstructed from the display. Work-model usage is accounted separately. Backend records survive, but cross-connection historical summaries, capability recovery, deletion/retention policy, rate-version evidence, invoice reconciliation, reservations and spending-cap enforcement remain open. No dollar ceiling is claimed or enforced by this change. Live-provider accounting acceptance remains separate from local transport/schema tests.

Verification exercises the production observation helper, immutable backend Storage receipts, shipped HTTP authorization/schema handlers and actual composer scope/retention behavior. Coordinated checkpoint results are recorded in the implementation progress document.
