# Raya API compatibility

## Explicit capability contracts

The server implementation adds `GET /kilocode/capabilities` without requiring a workspace. It follows the existing global authentication policy: configured server credentials are required when a password is set; standalone servers without a configured password allow unauthenticated discovery. Manifest version `1` contains a `features` object with these exact semantic versions:

| Feature | Version 1 guarantee |
|---|---|
| `client.vscode` | The backend implements the same-source HTTP/SSE contract required by the shipped `eden.raya` extension. The extension must confirm this before opening its event stream or exposing an SDK client. |
| `client.cli` | The CLI/TUI and its backend are built from the same source contract. The real TUI bootstrap fixture reads this flag through the generated SDK. |
| `client.console` | The bundled local console checks the backend generation before each logical SDK request batch, including before mutations and SSE. This does not claim UI parity with VS Code. |
| `events.additive` | Unknown additive event types may be ignored or rejected by an individual listener without terminating delivery of later known events. |
| `goal.commandCheck` | Goal criteria support `{ kind: "command", command, directory }`, and completion validates eligible successful evidence against the exact command string, including whitespace, and normalized explicit working directory. This does not establish semantic correctness or human acceptance. |

The extension checks `client.vscode` before opening SSE or making the SDK client available. A missing endpoint, malformed response, unknown manifest version, missing or unknown feature version, failed authentication, timeout, redirect, or connection error fails connection with update/reinstall guidance, before feature mutations can run. The webview's local drafts therefore remain available. It separately checks `goal.commandCheck` immediately before sending a goal edit containing a command-bound criterion. An unsupported server is never tested by sending a mutation and examining what survived decoding.

The host caches successful capability probes by SDK client identity, which changes when the connection service replaces its backend connection. Requests use that connection's credentials. The permission returned by a probe is checked synchronously immediately before dispatch, including after a delayed probe. Disconnecting or replacing the client invalidates the permission, even if the replacement uses the same address. Failed probes can be retried. This is an admission guarantee; a network failure after PATCH dispatch still requires reviewing saved state and is not automatically replayed.

## Contract ownership and current limits

| Surface | Shipped ownership | Compatibility evidence and limits |
|---|---|---|
| Extension HTTP and SSE | `packages/kilo-vscode/src/services/cli-backend/connection-service.ts`, `@kilocode/sdk/v2/client` | The generated legacy SDK drives the shipped extension. Health means the server responds; it does not establish support for optional-field semantics. |
| Raya capability manifest | `packages/opencode/src/kilocode/server/httpapi/groups/capabilities.ts`, `handlers/capabilities.ts` | An explicit additive endpoint advertises client-generation, event and feature semantic versions. Unknown required versions fail closed. Unrelated future fields are ignored. |
| VS Code connection admission | `packages/kilo-vscode/src/services/cli-backend/connection-service.ts`, `capabilities.ts` | The authenticated manifest is checked before SSE starts. A replaced client cannot inherit an in-flight or cached decision, even at the same URL. |
| Local console admission | `packages/kilo-console/src/client.ts` | Every constructed SDK client first reads the authenticated manifest through the raw transport. An incompatible or replaced backend receives no feature request. |
| Goal edit admission | `packages/kilo-vscode/src/kilo-provider/goal.ts`, `services/cli-backend/capabilities.ts` | Host validation precedes PATCH, and the existing saved-response comparison remains required. Missing negotiation wiring also blocks command-bound edits. |
| Goal completion contract | `packages/opencode/src/kilocode/goal/criteria.ts`, goal service | Command binding strengthens eligible evidence matching. Prose criteria do not gain arbitrary semantic verification from the capability flag. |
| Generated legacy SDK | `packages/sdk/js`, root `script/generate.ts` | Regeneration tracks endpoint schemas. Schema generation alone cannot prove compatibility with an older deployed server. |
| Experimental protocol client | `packages/client/src/contract.ts`, `packages/protocol/src/api.ts` | Separate from the shipped SDK. Existing identity tests check client/server schema parity within one source revision. They do not negotiate the shipped extension's semantic guarantees. |
| Intentional experimental omissions | `packages/client/src/contract.ts` | `fs.read`, `pty.connect`, and `pty.connectToken` are explicitly omitted from this contract adapter; their presence elsewhere must not be inferred from adapter parity. |

The supported Raya boundary is the same-source build documented in `Raya-Supported-Clients.md`; the client-generation flags deliberately cover that complete build rather than pretending every endpoint can be independently combined across arbitrary versions. Add a narrower feature flag when a semantic can evolve independently, as `goal.commandCheck` does. Direct API clients outside the supported build must negotiate the contracts they depend on.

## Regression coverage

- `packages/opencode/test/kilocode/server/httpapi-capabilities.test.ts` exercises the actual registered server endpoint without workspace mutation.
- `packages/opencode/test/kilocode/tui-bootstrap.test.ts` reads the CLI and console contract flags through the actual server and generated SDK during the blocking bootstrap workload.
- `packages/kilo-console/src/client.test.ts` proves an incompatible server receives no console mutation and an unknown event handler failure cannot stop a later known event.
- `packages/kilo-vscode/tests/unit/capabilities.test.ts` uses a real loopback HTTP server and the shipped SDK to check old-server 404, unknown versions, malformed/error replies, authenticated lookup, no mutation on unsupported edits, successful edits, safe cached probes, future-field tolerance, and connection replacement during a pending probe.
- `packages/kilo-vscode/tests/unit/sdk-sse-adapter.test.ts` proves incompatible extension/backend pairs fail before SSE, and that an unknown event handler failure does not block a later known event.
- `packages/kilo-vscode/tests/unit/goal-edit.test.ts` continues to verify saved criteria and command bindings rather than accepting capability negotiation as proof of persistence.

These fixtures describe intended checked behavior; release validation results belong in the implementation progress log.
