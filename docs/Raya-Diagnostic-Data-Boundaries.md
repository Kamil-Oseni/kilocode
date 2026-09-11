# Raya diagnostic data boundaries

This is the EN-13 implementation inventory. Local logs, optional test recordings, ordinary product telemetry and conversation data have different purposes and controls. None should be described as a universally sanitized diagnostic bundle.

## Open a diagnostic summary

Run **Raya: Open diagnostic summary** from the Command Palette. Raya opens an untitled JSON document for inspection and optional saving or sharing. The command does not connect to the backend, collect logs, copy to the clipboard or upload anything.

The version 1 summary deliberately includes only numeric extension/editor versions, a snapshot commit hash when recognized, OS/CPU categories, whether the extension runs remotely, workspace trust and folder count (capped at 100), current connection state and the editor's telemetry setting. Snapshot author names and build timestamps are removed from version strings. Workspace paths, hostnames, account identities, prompts, file contents, error bodies, credentials and environment variables are not collected. Unknown category values become `unknown`; extra properties are never serialized.

This is a small allowlisted export, not a dump of arbitrary objects passed through a redactor. It reports editor consent, not proof that a backend acknowledged the latest consent change. It reports connection state, not provider health or successful task completion. Backend capabilities, timing measurements and broader support diagnostics remain separate work. The existing heap-snapshot command is a different artifact that can contain process memory; it is not covered by this summary's field contract.

## Current data paths

| Category | Data and purpose | Destination | Enablement and retention |
|---|---|---|---|
| Extension telemetry | Event name plus event-specific and provider properties | Authenticated local CLI `/telemetry/capture`, then its telemetry client | The extension checks VS Code telemetry consent before enrichment or dispatch. Upstream retention is not established by this repository. |
| CLI telemetry | Product events, app/platform metadata and event-specific properties | PostHog at `https://us.i.posthog.com` | `KILO_TELEMETRY_LEVEL` overrides the configured initial enablement; the runtime endpoint updates enablement. Delivery already in flight is not recalled by opt-out. |
| Telemetry identity | Machine ID, and signed-in identity where available; organization ID where configured | Used as event identity; local identity/profile cache | Local files include `telemetry-id` and `telemetry-profile.json`. The profile cache holds an email, token hash and timestamp, not the raw token. A seven-day refresh threshold is not a deletion policy. |
| Extension console diagnostics | Operational messages and errors | VS Code extension host logs | Product telemetry consent is not a general log-retention control. The telemetry wrapper no longer writes raw event properties to the console before checking consent. Other logging callers still require review. |
| HTTP/WebSocket test cassettes | Request/response or socket interactions for reproducible tests | Explicit recorder directory, default `test/fixtures/recordings` | Recorder invocation and record/replay mode are separate from telemetry consent. No ordinary product recorder integration was identified in the initial TypeScript import inventory; this is not a claim that all logging is disabled. |
| Conversations, voice and browser state | Operational product content and session recovery | Their respective session, media and browser stores/providers | These are not telemetry merely because diagnostics can reference them. Their retention and export controls require separate acceptance. |

The telemetry ingest key embedded in source identifies a public ingest project; its presence alone does not establish that collection is enabled. Effective enablement must be tested at the caller and the receiving backend.

## Caller boundary correction

The static `TelemetryProxy.capture` entry point previously logged the event and its properties before delegating to the instance method. The instance correctly checked VS Code consent, but opting out still left the properties in the local console. The unconditional log has been removed for both consent states.

The regression invokes that actual static entry point using the existing VS Code test adapter and a real loopback HTTP receiver. It checks that opting out avoids property enrichment, local console output and dispatch, and that opting in still sends the expected event to the local receiver without copying it to the console. It does not send any telemetry to PostHog. Pending and completed check outcomes are recorded in the implementation progress document.

## Recorder guarantees and limits

The recorder allowlists headers, redacts configured query names and URL credentials, and can replace known sensitive JSON fields. Its cassette writer also refuses recognized token patterns and matching environment-secret values before writing an interaction. Those mechanisms are useful but are not proof that arbitrary content is safe to share.

Plain text, SSE payloads, nested error messages, user-defined field names, short secrets, encoded values and private information that is not a credential need their own policy. A synthetic token detector does not remove a person's name, unpublished source code or an ordinary-language company secret. Recorder transformations and refusal behavior must be verified through the actual writer, not just helper functions. Recordings should remain local until a reviewed export mechanism establishes what they contain.

### Declared binary recordings

The cassette writer now inspects decoded bytes for explicitly base64-encoded HTTP responses and binary WebSocket frames. It applies the existing recognized-token and environment-secret checks to their UTF-8 projection before writing; it never rewrites binary content. Canonical base64 is required, including padding and zero padding bits. Invalid encodings and an aggregate decoded size above 8 MiB per inspected interaction are refused before publication. Safe binary data remains byte-for-byte replayable. The budget bounds this added decoding, not the recorder's overall capture memory or total cassette size.

This closes transport encoding hiding a known token. It does not decompress content, inspect encrypted files, recognize arbitrary encodings embedded in ordinary text, or guarantee that private information is absent. Existing cassette reads are not retroactively scanned or rewritten. JSON/text/SSE/URL/nested-error/text-frame checks retain the existing detection policy; short or unknown secrets and ordinary private text remain outside that policy. Recording stays separate from telemetry consent.

Actual filesystem-writer regression coverage checks refusal across these supported representations, preservation of a prior safe cassette, absence of unsafe files/publication remnants, and omission of synthetic secret values from error messages. A loopback HTTP case exercises binary capture through the recorder itself; the existing safe binary record/replay fixture protects byte fidelity. Validation outcomes are recorded in the progress log.

## Connection-bound telemetry transport

The extension now drops its endpoint and cancels pending requests on backend disconnection, replacement and shutdown. Capture checks consent before enrichment and again after serialization, so provider callbacks cannot forward an event using obsolete connection or consent state. Capture concurrency is bounded at 32 pending requests; requests have a ten-second deadline, refuse redirects and report only content-free failure messages. Callers may await transport settlement; this does not establish final analytics delivery.

Actual loopback HTTP tests cover opt-out, reentrant disconnection and serialization, endpoint removal, redirects, non-success responses and cancellation. These do not establish receiving-side consent ordering: concurrent consent updates can still arrive out of order, and aborting a request cannot undo an event already accepted by the backend. Durable consent synchronization and final outbound behavior remain open.

## Remaining implementation and acceptance

- Extend the implemented allowlisted summary with versioned feature availability and bounded timing/status measurements where supported. Preserve its explicit field contract and test every added field; no complete support bundle is claimed here.
- Inventory telemetry event properties and receiving endpoints, including free-form error and feedback fields. Document a company retention/deletion policy rather than infer it from a library setting.
- Verify runtime opt-out propagation, failed acknowledgments, reordered consent changes and reconnection. The connection-bound proxy does not provide a durable consent synchronization guarantee.
- Verify telemetry enabled/disabled behavior at the CLI receiver and final outbound transport with synthetic events, including queued events and identity updates.
- Extend the verified writer matrix as supported formats change; compressed, encrypted and arbitrarily encoded content still require a separate policy. Known-token detection does not approve recordings for sharing.
- Provide an explicit, separate recording/export choice where a product workflow actually introduces sensitive recording. Do not treat ordinary telemetry enablement as consent to record conversations.
- Review log destinations, access and rotation on each supported platform, and connect deletion controls to the actual stored artifacts.

## Sources

- [Diagnostic command](../packages/kilo-vscode/src/commands/diagnostics.ts), [field projection](../packages/kilo-vscode/src/services/diagnostics.ts) and [synthetic export checks](../packages/kilo-vscode/tests/unit/diagnostics.test.ts)
- [Extension caller](../packages/kilo-vscode/src/services/telemetry/telemetry-proxy.ts), [payload construction](../packages/kilo-vscode/src/services/telemetry/telemetry-proxy-utils.ts) and [boundary regression](../packages/kilo-vscode/tests/unit/telemetry-proxy-boundary.test.ts)
- [Managed backend consent at launch](../packages/kilo-vscode/src/services/cli-backend/server-manager.ts) and [runtime propagation](../packages/kilo-vscode/src/extension.ts)
- [CLI initialization](../packages/kilo-telemetry/src/telemetry.ts), [outbound client](../packages/kilo-telemetry/src/client.ts) and [identity cache](../packages/kilo-telemetry/src/identity.ts)
- [Recorder redactor](../packages/http-recorder/src/redactor.ts), [secret detection](../packages/http-recorder/src/redaction.ts) and [cassette writer](../packages/http-recorder/src/cassette.ts)
