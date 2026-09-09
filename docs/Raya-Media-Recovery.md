# Media session ownership and recovery

## Implemented contract

The media manager claims a session ID before opening its engine or joining its room. A duplicate start cannot allocate another pair of resources for that ID. The claim remains present during setup and teardown.

Stop and service shutdown cancel pending setup. Established sessions preserve request context values but no longer inherit the HTTP request's cancellation lifetime. Explicit Stop and shutdown still cancel the established session. Shutdown prevents new starts.

Successful cleanup releases only the matching ownership claim, allowing a later start. Concurrent session Close calls wait for the same cleanup and return its retained error. A cleanup failure leaves resource release uncertain: the manager keeps the claim, rejects replacements, and returns the failure on subsequent Stop/shutdown calls. It does not retry uncertain cleanup silently.

## Recovering from failed cleanup

The returned error directs the operator to restart the media frontend before reconnecting. Inspect the error and any remaining provider/room activity, restart the separately operated media service, then establish a new session. Restarting clears this process's ownership records; this is not proof that an external provider has terminated all work. Preserve relevant diagnostics when investigating a repeated failure.

This change has not been deployed. Updating the extension alone does not rebuild or restart an existing media-service deployment.

## Verified locally

Run from `services/raya-mf` using the existing Go toolchain:

| Setting | Verified value |
|---|---|
| `GOTOOLCHAIN` | `local` |
| `CGO_ENABLED` | `0` |
| `GOCACHE` | Absolute path to the repository's `.tmp/media-go-cache` |

The focused ownership/concurrent-close tests passed 20 repetitions with a 30-second test timeout. `go test ./... -count=1 -timeout=60s`, `go vet ./...`, Go formatting, and scoped whitespace checks also passed.

Tests exercise the actual manager/session implementation with controlled engine and room adapters. They cover duplicate allocation, pending setup cancellation, successful cleanup and retry, replacement refusal during cleanup, preserved established-session lifetime and context values, shutdown exclusion, stable concurrent Close results, and retained setup/active-session cleanup failures.

Evidence logs:

- `.tmp/media-go-ownership-recheck.log`
- `.tmp/media-go-service-final.log`
- `.tmp/media-go-vet-final.log`
- `.tmp/media-go-race.log`

## Verification limits and remaining EN-12 work

CGO-disabled builds use the explicit unsupported LiveKit stub in `internal/room/livekit/stub.go`. Passing those tests does not compile or exercise the production CGO/libopus adapter. The attempted race-detector run failed because the existing environment lacks `gcc`; no compiler was installed. Default-cache standard-library resolution failed, while the isolated workspace cache succeeded; the underlying cause has not been established.

Production adapter compilation, race detection, and real LiveKit disconnect/reconnect tests remain release prerequisites for this subsystem. Typed media lifecycle and recovery events, ignored streaming send/publish/interrupt failures, queue overflow/backpressure, and terminal transport cleanup also remain outstanding. The OpenAI realtime migration is a separate, unfinished overhaul.

## Streaming failure and recovery increment

This increment implements the critical streaming-error and bounded event-queue handling previously listed as outstanding above. EN-12 remains incomplete: production transport lifecycle, real-device interruption/reconnect behavior, and supported release validation still need work.

The media session now retains its first terminal failure with a stable boundary code, a sanitized explanation, recovery steps, and a timestamp. Critical microphone push, audio publish, playout metadata, transcript delivery, flush, engine interruption, interruption notification, context injection, backend delivery, closed input/output/event channels, and engine-reported errors stop the stream. Provider error payloads are not copied into these failure messages or failure-event telemetry. Interruption flushes the recorded assistant playout item rather than the incoming microphone frame's item.

The 64-entry backend event queue no longer silently discards overflow. Overflow stops the session and reports `event_queue_overflow`; the persisted failure marks the transcript incomplete. A first failure is retained even if additional boundaries subsequently fail.

A dedicated session supervisor owns failure notification and teardown. Workers report a failure and return; they do not wait for their own worker group. The supervisor attempts one independent notification to the room and one to the backend, records whether each attempt succeeded, closes engine/room resources, and waits for workers. Failed notification attempts do not recursively enqueue more error notifications. Close waits for the supervisor, preserving the earlier ownership and retained-cleanup-error guarantees.

Reporting uses a 40 ms room context and a 150 ms backend context. These are cooperative adapter deadlines, not proof that every production adapter operation terminates within those intervals. A cleanup error remains separately observable and keeps the ownership claim reserved.

### Readable and persisted outcomes

`GET /v1/sessions/{id}` on the media service returns its process-local state, first failure, room/backend notification outcomes, and cleanup outcome. Missing backend configuration is reported as `not_configured`, not as successful delivery. Failed cleanup remains readable after Close returns an error; successful explicit Close removes the local session record. This endpoint is not a disk-backed failure archive and cannot recover observations after the media process exits.

When backend notification succeeds, the Raya voice state persists the first normalized failure and an incomplete transcript marker. Backend restart/readback preserves that outcome. Late events cannot reactivate failed or closed voice sessions, replace their first failure, or dispatch new delegation work. Voice get/event/close operations serialize per session so an older in-flight storage write cannot overwrite a later failure without serializing unrelated sessions behind the same gate. Voice sessions created by the backend receive distinct IDs.

The webview displays the recovery explanation, releases microphone/playout/transport resources, and offers reconnecting with the selected provider or continuing by typing. Active-room terminal failure and disconnect handling do not automatically switch to the speech cascade. Existing connection-setup fallback and explicitly selected cascade configuration paths have not been migrated by this increment.

Callbacks and asynchronous rejection handling are bound to the current connection generation. Delayed old-room data, disconnect events, connect rejection, and playout-flush rejection cannot stop a replacement connection. Transport disconnect is still attempted if microphone cleanup rejects. Malformed control packets are ignored safely.

### Verification for this increment

Go commands ran from `services/raya-mf`, with `GOTOOLCHAIN=local`, `CGO_ENABLED=0`, and the existing repository `.tmp/media-go-cache`:

- `go test ./internal/app -run 'TestCritical|TestQueue|TestFailedReporting|TestFailure|TestManager|TestConcurrent' -count=10 -timeout=30s` passed.
- `go test ./... -count=1 -timeout=60s` passed.
- `go vet ./...` passed.
- `gofmt -l` and scoped `git diff --check` were clean.

The Go tests use the actual session supervisor/manager with controlled boundary adapters. They cover 14 individual critical boundaries, queue overflow, both reporting transports failing, cleanup-error retention, first-error retention, sanitized output, readable manager state, and all earlier ownership regressions. A real local HTTP test verifies the backend event route, directory context, authorization header, and sanitized normalized failure body.

From `packages/opencode`, `bun test ./test/kilocode/voice-failure.test.ts ./test/kilocode/voice-reconstructor.test.ts ./test/kilocode/voice-api-contract.test.ts` passed 9 tests and 24 assertions. Failure tests use actual Storage, including restart/readback, closure, late events, raw legacy error normalization, and a held earlier write. Scoped CLI lint passed with 3 warnings and no errors. Combined CLI type validation and generated SDK/OpenAPI validation are coordinated by the root implementation task.

From `packages/kilo-vscode`, `bun test tests/unit/realtime-failure.test.ts tests/unit/realtime-voice.test.ts` passed 10 tests and 92 assertions. Tests drive actual LiveKit Room event emitters with controlled transport/audio boundaries; they do not establish live audio quality or network performance. Final `bun run check-types:webview`, `bun run check-types`, and scoped ESLint passed. A duplicate agent Knip invocation was cancelled in favor of the root's already-running Knip validation; this cancellation is not a passing Knip result.

Evidence logs:

- `.tmp/media-go-failures-repeat.log`
- `.tmp/media-go-streaming-service.log`
- `.tmp/media-go-streaming-vet.log`
- `.tmp/media-voice-persistence-final.log`
- `.tmp/media-voice-client-final.log`
- `.tmp/media-webview-types-final.log`
- `.tmp/media-host-types-final.log`
- `.tmp/media-extension-lint-final.log`
- `.tmp/media-cli-lint.log`

### Remaining limits

The CGO-disabled service tests still exclude the production LiveKit adapter. The earlier race-detector attempt remains blocked by the missing C compiler. This increment does not demonstrate real microphone/device handling, production LiveKit terminal-disconnect signaling, recovery from adapters that ignore cancellation, latency targets, or absence of transport goroutine leaks. The separately operated Go service must be rebuilt and deployed for its behavior to change; no deployment or packaged extension validation was performed here.

No automatic reconnect/session rollover, complete connecting/listening/thinking/speaking/interrupted/reconnecting state model, production media dependency pinning, or OpenAI realtime migration is claimed. Local notification observations disappear with the media process unless the normalized failure reached the backend; failed notification delivery is visible locally and in sanitized service logs rather than being represented as durable backend history.