# Raya API compatibility

## Explicit capability contracts

The server implementation adds `GET /kilocode/capabilities` without requiring a workspace. It follows the existing global authentication policy: configured server credentials are required when a password is set; standalone servers without a configured password allow unauthenticated discovery. Manifest version `1` contains a `features` object. The `goal.commandCheck` value `1` means that goal criteria support the optional `{ kind: "command", command, directory }` check and completion validates eligible successful command evidence against the exact command string (including whitespace) and normalized explicit working directory. It does not establish general semantic correctness of the result or human acceptance.

This extension implementation checks this contract before sending a goal edit containing a command-bound criterion. A missing endpoint, malformed response, unknown manifest version, missing or unknown feature version, failed authentication, timeout, redirect, or connection error blocks the mutation. The editor retains its draft and offers update/reconnect guidance. An unsupported server is never tested by sending a mutation and examining what survived decoding. Existing prose-only edits remain supported without negotiation; their saved-response checks still apply.

The host caches successful capability probes by SDK client identity, which changes when the connection service replaces its backend connection. Requests use that connection's credentials. The permission returned by a probe is checked synchronously immediately before dispatch, including after a delayed probe. Disconnecting or replacing the client invalidates the permission, even if the replacement uses the same address. Failed probes can be retried. This is an admission guarantee; a network failure after PATCH dispatch still requires reviewing saved state and is not automatically replayed.

## Contract ownership and current limits

| Surface | Shipped ownership | Compatibility evidence and limits |
|---|---|---|
| Extension HTTP and SSE | `packages/kilo-vscode/src/services/cli-backend/connection-service.ts`, `@kilocode/sdk/v2/client` | The generated legacy SDK drives the shipped extension. Health means the server responds; it does not establish support for optional-field semantics. |
| Raya capability manifest | `packages/opencode/src/kilocode/server/httpapi/groups/capabilities.ts`, `handlers/capabilities.ts` | An explicit additive endpoint advertises supported semantic versions. Unknown versions fail closed for dependent goal edits. Unrelated future fields are ignored. |
| Goal edit admission | `packages/kilo-vscode/src/kilo-provider/goal.ts`, `services/cli-backend/capabilities.ts` | Host validation precedes PATCH, and the existing saved-response comparison remains required. Missing negotiation wiring also blocks command-bound edits. |
| Goal completion contract | `packages/opencode/src/kilocode/goal/criteria.ts`, goal service | Command binding strengthens eligible evidence matching. Prose criteria do not gain arbitrary semantic verification from the capability flag. |
| Generated legacy SDK | `packages/sdk/js`, root `script/generate.ts` | Regeneration tracks endpoint schemas. Schema generation alone cannot prove compatibility with an older deployed server. |
| Experimental protocol client | `packages/client/src/contract.ts`, `packages/protocol/src/api.ts` | Separate from the shipped SDK. Existing identity tests check client/server schema parity within one source revision. They do not negotiate the shipped extension's semantic guarantees. |
| Intentional experimental omissions | `packages/client/src/contract.ts` | `fs.read`, `pty.connect`, and `pty.connectToken` are explicitly omitted from this contract adapter; their presence elsewhere must not be inferred from adapter parity. |

EN-07 remains broader than this first capability: routine, browser, media, repair and event evolution still need feature-specific compatibility decisions and a supported-version matrix. Do not treat this single manifest flag as approval for all optional fields or event payloads. Direct API clients must negotiate the contracts they depend on; this change enforces the exact-command requirement in the shipped extension's goal editor path.

## Regression coverage

- `packages/opencode/test/kilocode/server/httpapi-capabilities.test.ts` exercises the actual registered server endpoint without workspace mutation.
- `packages/kilo-vscode/tests/unit/capabilities.test.ts` uses a real loopback HTTP server and the shipped SDK to check old-server 404, unknown versions, malformed/error replies, authenticated lookup, no mutation on unsupported edits, successful edits, safe cached probes, prose-only compatibility, and connection replacement during a pending probe.
- `packages/kilo-vscode/tests/unit/goal-edit.test.ts` continues to verify saved criteria and command bindings rather than accepting capability negotiation as proof of persistence.

These fixtures describe intended checked behavior; release validation results belong in the implementation progress log.
