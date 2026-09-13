# Raya local service topology

This document records the current managed launch contract and the remaining EN-10 work. It does not certify shared or remote deployment.

## Managed VS Code backend

The extension launches its bundled CLI with an ephemeral port, explicit `127.0.0.1` hostname and disabled mDNS. These explicit arguments override standalone CLI server settings. `ServerManager` generates a fresh 32-byte random password for each child process and supplies it through `KILO_SERVER_PASSWORD`; the extension uses that credential for HTTP and SSE. The password is not a tenant identity.

One connection service serves the sidebar, editor tabs and Agent Manager within an extension host. Requests include directory context where needed. Directory context selects workspace data; it does not authorize a different person, isolate every in-memory service, or start a separate backend. Other local processes running as the same OS user remain within the local trust boundary.

The parent PID is passed to the backend watchdog. Graceful disposal and process-exit handling remain responsible for teardown. A loopback bind does not prove that every abrupt-exit or multi-window recovery path has passed acceptance.

The contract regression imports the exact launch arguments used by `ServerManager` and evaluates them using the CLI's actual argument parser and network resolver, against a configuration requesting `0.0.0.0`, a fixed port and mDNS. It verifies loopback, port zero and disabled discovery. Packaged socket inspection is a separate acceptance step.

## Voice control and media

| Link | Current behavior | Boundary or remaining work |
|---|---|---|
| Extension to CLI voice control | Managed backend HTTP with generated Basic credentials | Carries session and directory context, not independent tenant authentication. |
| Extension to media frontend | Numeric loopback HTTP origin; default `http://127.0.0.1:7890`; shared service key plus per-session bearer capability | Keys stay in the extension host, managed CLI and companion. Remote/shared deployment is unavailable. |
| Media frontend listener | Native default `127.0.0.1:7890`; numeric loopback addresses are accepted directly | Any wildcard, hostname, LAN or public bind requires the exact opt-in `RAYA_MF_ALLOW_NON_LOOPBACK=1`. |
| Docker media frontend | Listens on `0.0.0.0` inside the container through the explicit non-loopback opt-in; Compose publishes host `127.0.0.1:7890` | Host publication and container-network reachability remain different boundaries. The opt-in records deployment intent; it does not authenticate container-network callers. |
| Media frontend to backend | Voice events carry the supplied backend authorization and directory to a validated numeric loopback HTTP origin | Redirects are refused. Remote callbacks are unavailable. |
| LiveKit and voice engine | WebRTC/audio and provider connection are separate from CLI control | Tokens, provider keys, remote rooms and cleanup require their own lifecycle guarantees. |

The Go control server limits request headers to 32 KiB, header reading to five seconds, total request reading to fifteen seconds, response writes to thirty seconds and idle connections to sixty seconds. Session-start and context-injection JSON bodies are limited to 1 MiB, including chunked bodies without a declared content length. The complete body is read within the limit and parsed before session side effects; trailing JSON is rejected. Audio travels through WebRTC and is not subject to this JSON body limit.

These are HTTP transport limits, not a claim that every provider operation or cleanup routine terminates by the response deadline. The extension broker separately bounds its requests and retains uncertain cleanup ownership. The media companion must be rebuilt to apply these service changes; installing a VS Code snapshot alone does not replace a running companion container.

### Speech credential roles

Realtime voice, transcription and synthesis use separate SecretStorage entries. A missing realtime key no longer falls back to the transcription key: the configured realtime provider can differ from the transcription provider. Settings report realtime readiness only when its own key exists, and the optional CLI mirror preserves the same separation. Existing users who relied on the fallback must explicitly configure the realtime key; the transcription and synthesis keys remain stored.

The regression uses in-memory storage adapters and synthetic credentials to test role separation, plus an actual temporary CLI-mirror file. It does not test VS Code's encryption implementation. Configurable endpoint authorization, mirror-file protection and the broader OpenAI transport migration remain separate work.

## Remaining acceptance work

- Complete handler/provider lifecycle limits and observe cancellation and cleanup after HTTP transport deadlines, without applying short HTTP timeouts to long-lived audio sessions.
- Preserve initial destination validation and redirect refusal before sending credentials. Endpoint authentication remains separate.
- Exercise authenticated and unauthenticated requests on actual managed sockets, abrupt parent exit and cross-window ownership.
- Test cross-directory data and execution ownership separately from authentication.
- Keep remote/shared launch support unavailable as a product claim until its authentication, origin and isolation contract is implemented and exercised.

## Source references

- [Managed launcher](../packages/kilo-vscode/src/services/cli-backend/server-manager.ts) and [launch arguments](../packages/kilo-vscode/src/services/cli-backend/server-utils.ts)
- [CLI network precedence](../packages/opencode/src/cli/network.ts) and [launch contract regression](../packages/opencode/test/kilocode/managed-server-network.test.ts)
- [Backend authentication](../packages/server/src/auth.ts)
- [Voice broker](../packages/kilo-vscode/src/speech/realtime-broker.ts)
- [Media HTTP server](../services/raya-mf/cmd/raya-mf/main.go), [Compose publication](../services/raya-mf/docker-compose.yml) and [callback transport](../services/raya-mf/internal/app/backend.go)
- [Control transport limits](../services/raya-mf/internal/control/http.go) and [real HTTP boundary/deadline tests](../services/raya-mf/internal/control/http_test.go)

## Control redirect boundaries

The extension voice broker now uses manual redirect handling for backend/media admission and teardown. It never follows 301, 302, 303, 307 or 308 responses, including same-origin redirects: credentials appear in both request headers and media-start bodies. A redirected backend admission without an identified session remains unconfirmed and keeps the broker busy; failed cleanup also retains ownership. No redirect Location or provider response body is copied into user errors.

The media companion callback transport refuses redirects with a per-call copy of the HTTP client, preserving any injected caller client settings without mutating its redirect policy. The CLI context-injection transport similarly refuses redirects and reports the status without replaying the workspace result to another recipient. A direct successful endpoint remains supported. These changes do not validate the initially configured endpoint, authenticate the media service, or certify remote/shared deployment. The separate Go companion must be rebuilt before its callback change takes effect.

The actual broker suite passed 46 tests and 342 assertions across admission/cleanup stages, all five redirect statuses, and same-origin/other-port destinations with synthetic credentials. The full Go service suite and `go vet ./...` passed with CGO disabled; callback tests verify original request identity/body, zero redirected requests, no replay and caller-client preservation. The CLI transport plus existing voice-failure suite passed 15 tests and 54 assertions (native zero); context tests cover direct success and both redirect destination classes. New transport source/test lint reports zero warnings/errors. Existing voice-service code retains three scoped warnings. Combined package gates are recorded with the next checkpoint.

## Initial destination validation

The Qwen broker now validates both its managed CLI backend and media frontend before its first network request. Each must be an `http` origin with no credentials, path, query or fragment and a numeric loopback address in `127.0.0.0/8` or `::1`. Names such as `localhost`, private-LAN addresses and lookalike domains are refused so DNS or configuration cannot redirect backend credentials, provider keys or media tokens. Accepted addresses are normalized once and the same origins are used for admission and cleanup.

The CLI independently validates `mediaURL` before parent lookup, delegate creation, room-token minting or persistence. Its real authenticated HTTP route returns `400` for an unsafe destination. The Go media companion independently validates the callback backend before reserving a session, opening the voice engine or joining the media room. This is defense in depth across callers; it does not authenticate the media control listener or authorize a remote/shared topology.

ChatGPT verified this boundary on 2026-09-13 with 48 extension broker tests and 359 assertions, two CLI destination tests with 13 assertions, the real voice HTTP test with 46 assertions, an uncached full `go test ./...`, `go vet ./...`, and a native 10,135,040-byte companion rebuild. No paid provider or microphone was used.

## Listener exposure gate

The media companion now refuses any listener address that is not a numeric loopback address unless the deployment sets the exact flag `RAYA_MF_ALLOW_NON_LOOPBACK=1`. Changing `RAYA_MF_ADDR` alone can no longer expose control routes on a wildcard, hostname, LAN or public interface. Malformed addresses fail before `net.Listen`.

The checked-in Compose deployment declares the opt-in because its process must listen on the container wildcard address; its published host ports remain pinned to `127.0.0.1`. The flag makes that exposure decision reviewable but does not authenticate callers already inside the container network. Remote/shared deployment remains unsupported.

ChatGPT verified this boundary on 2026-09-13 with 11 focused address cases, the uncached full companion suite, `go vet ./...`, and a 10,156,544-byte native rebuild. The Docker image was not built or deployed in this checkpoint to avoid an unnecessary high-memory operation.

## Media control authentication and browser boundary

Every `/v1/` control request now requires two independent credentials. `RAYA_MF_TOKEN` is a 32-byte base64url service key shared through the environment of VS Code and the media companion. The managed backend launcher explicitly removes it from the CLI environment so tool child processes cannot inherit it. The extension transmits it once to the authenticated loopback CLI in a credential header; the CLI retains it only in the live voice entry and mints a separate random 32-byte control capability for that session. The extension host sends both values only in headers when it admits or closes media work. The CLI uses both for context injection. The service key is neither included in JSON bodies nor persisted in Raya state. The session capability is persisted with the voice session so a restored backend does not silently replace its ownership credential, and older stored sessions receive one during migration.

The companion stores only a SHA-256 digest of each active session capability and compares both credentials in constant time. A missing, malformed or incorrect service key or bearer capability returns `401` before parsing a control body or allocating voice/room resources. A capability for one session cannot read, inject into or close another. `/healthz` remains credential-free for local process readiness.

Browser-origin requests are refused with `403` before reaching `/v1/` handlers when they carry `Origin` or `Sec-Fetch-Site`. Browser requests that attempt a custom credential header must also pass a CORS preflight, and the service exposes no CORS permission. Node and Go control clients send neither browser header. This policy is defense in depth around the authenticated loopback service; it is not a claim that hostile processes running as the same OS user are isolated.

Generate a key with `bun run --silent voice:key`, then set `RAYA_MF_TOKEN` in the shell that starts the companion and VS Code. For the checked-in development stack on PowerShell:

```powershell
$env:RAYA_MF_TOKEN = (bun run --silent voice:key).Trim()
bun run extension:voice
```

Compose refuses to start `raya-mf` without the variable. Rotating the key requires restarting both the companion and Raya because existing service-key authorization becomes invalid. GPT-Live and OpenAI Realtime do not use this separate Qwen media companion.

ChatGPT verified this boundary on 2026-09-13 with the real Go router, service-key parser, browser filter and ownership manager; 49 extension broker tests with 370 assertions; 34 managed-server environment tests with 58 assertions; 19 focused CLI voice tests with 122 assertions; the generated API contract with 11 assertions; the uncached full companion suite; `go vet ./...`; extension-host and SDK typechecks; and a 10,168,832-byte native rebuild. The key generator emits exactly one 43-character base64url value. No paid provider, microphone or Docker deployment was used.
