# Voice admission ownership and recovery

The shipped extension still uses the `SpeechService` broker, CLI voice sessions, the separately operated Go media frontend, and the LiveKit/Qwen client. The OpenAI voice architecture document is a proposed migration; it is not the runtime changed here. Existing Go session ownership and streaming failure work is described in [Media recovery](Raya-Media-Recovery.md).

Each chat provider's broker reserves ownership before asynchronous settings lookup or HTTP admission. A second Start receives an explicit busy result. It does not allocate another backend session, replace an active session, or replay an uncertain admission. Stop and disposal mark pending setup cancelled, wait for its outcome, and close every identified resource before releasing ownership. A cancelled start never publishes a ready connection. Other chat providers remain independent owners.

When media setup fails after backend admission, cleanup addresses both known media and backend session IDs. Cleanup requests run independently, with bounded timeouts, and check HTTP responses. The broker retains the outcome for concurrent and subsequent Stop calls. Failed or uncertain cleanup retains ownership and prevents new admission; it is not silently retried. Existing media deployments use HTTP 404 for both a missing session and some cleanup failures, so 404 alone is not accepted as proof of release.

An admission whose acknowledgement is lost may have created remote work. When the backend did not return an ID, the broker cannot safely identify that work for deletion. When media admission times out, successful deletion of both identified resources can confirm cleanup; an early not-found response cannot. The error explains that resource release is unconfirmed and asks the user to end voice and restart the media frontend and Raya before reconnecting. Restarting clears process-local ownership; it does not prove that every external provider resource has terminated.

Errors use stable configuration, busy, setup, cleanup, unknown-admission, or cancelled codes. Provider response bodies, keys, and raw transport errors are excluded from the explanation. Explicit cascade configuration remains available. An operational setup or cleanup failure does not silently start another speech provider.

The webview requests backend teardown when its realtime transport fails, retains the degraded explanation after the stopped acknowledgement, and handles microphone/transport cleanup rejection. A stale connection-start rejection cannot stop a replacement connection.

## Verification scope

The broker tests use actual loopback HTTP requests and the production ownership implementation with synthetic credentials. They cover overlapping Start, Stop during pending admission, partial setup failure, concurrent Stop, retained cleanup failure, lost acknowledgements, and disposal during settings lookup. No real conversations, paid provider calls, or external deployment are involved.

Live microphones, production LiveKit/CGO adapters, real provider termination, and latency are not established by these tests. This increment does not complete every remaining EN-12 production-validation requirement.
