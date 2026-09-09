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
| Media frontend to backend | Voice events carry the supplied backend authorization and directory | Callback destination and redirect policy need explicit validation. |
| LiveKit and voice engine | WebRTC/audio and provider connection are separate from CLI control | Tokens, provider keys, remote rooms and cleanup require their own lifecycle guarantees. |

The Go HTTP server currently limits header reading to five seconds. That does not bound JSON body size, body reading, session admission or every handler lifetime. The extension broker bounds its requests and retains uncertain cleanup ownership; that does not establish server-side request limits.

## Remaining acceptance work

- Define and enforce the allowed media control deployment, including local native and container paths, service authentication and browser-origin handling.
- Bound control request bodies and handler lifetimes without applying short HTTP timeouts to long-lived audio sessions.
- Validate callback and configured media destinations before sending credentials; test redirect handling with synthetic credentials.
- Exercise authenticated and unauthenticated requests on actual managed sockets, abrupt parent exit and cross-window ownership.
- Test cross-directory data and execution ownership separately from authentication.
- Keep remote/shared launch support unavailable as a product claim until its authentication, origin and isolation contract is implemented and exercised.

## Source references

- [Managed launcher](../packages/kilo-vscode/src/services/cli-backend/server-manager.ts) and [launch arguments](../packages/kilo-vscode/src/services/cli-backend/server-utils.ts)
- [CLI network precedence](../packages/opencode/src/cli/network.ts) and [launch contract regression](../packages/opencode/test/kilocode/managed-server-network.test.ts)
- [Backend authentication](../packages/server/src/auth.ts)
- [Voice broker](../packages/kilo-vscode/src/speech/realtime-broker.ts)
- [Media HTTP server](../services/raya-mf/cmd/raya-mf/main.go), [Compose publication](../services/raya-mf/docker-compose.yml) and [callback transport](../services/raya-mf/internal/app/backend.go)
