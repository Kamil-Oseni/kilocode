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
| Extension to media frontend | Configurable HTTP URL; default `http://127.0.0.1:7890` | Control handlers currently have no service authentication. Arbitrary configured destinations are not a certified deployment. |
| Media frontend listener | Native default `127.0.0.1:7890`; environment can override | Non-loopback configuration is not yet gated. |
| Docker media frontend | Listens on `0.0.0.0` inside the container; Compose publishes host `127.0.0.1:7890` | Host publication and container-network reachability are different boundaries. Do not simply reject all wildcard container listeners without replacing this launch path. |
| Media frontend to backend | Voice events carry the supplied backend authorization and directory | Redirects are refused; configured callback destination validation remains open. |
| LiveKit and voice engine | WebRTC/audio and provider connection are separate from CLI control | Tokens, provider keys, remote rooms and cleanup require their own lifecycle guarantees. |

The Go control server limits request headers to 32 KiB, header reading to five seconds, total request reading to fifteen seconds, response writes to thirty seconds and idle connections to sixty seconds. Session-start and context-injection JSON bodies are limited to 1 MiB, including chunked bodies without a declared content length. The complete body is read within the limit and parsed before session side effects; trailing JSON is rejected. Audio travels through WebRTC and is not subject to this JSON body limit.

These are HTTP transport limits, not a claim that every provider operation or cleanup routine terminates by the response deadline. The extension broker separately bounds its requests and retains uncertain cleanup ownership. The media companion must be rebuilt to apply these service changes; installing a VS Code snapshot alone does not replace a running companion container.

### Speech credential roles

Realtime voice, transcription and synthesis use separate SecretStorage entries. A missing realtime key no longer falls back to the transcription key: the configured realtime provider can differ from the transcription provider. Settings report realtime readiness only when its own key exists, and the optional CLI mirror preserves the same separation. Existing users who relied on the fallback must explicitly configure the realtime key; the transcription and synthesis keys remain stored.

The regression uses in-memory storage adapters and synthetic credentials to test role separation, plus an actual temporary CLI-mirror file. It does not test VS Code's encryption implementation. Configurable endpoint authorization, mirror-file protection and the broader OpenAI transport migration remain separate work.

## Remaining acceptance work

- Define and enforce the allowed media control deployment, including local native and container paths, service authentication and browser-origin handling.
- Complete handler/provider lifecycle limits and observe cancellation and cleanup after HTTP transport deadlines, without applying short HTTP timeouts to long-lived audio sessions.
- Validate callback and configured media destinations before sending credentials. Redirect refusal has loopback HTTP coverage; endpoint authorization remains separate.
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
