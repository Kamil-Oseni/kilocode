# Raya cost accounting

## Implemented increment

OVR-04 now has a first persisted provenance path through the existing session processor, step storage, generated API/SDK, session-family aggregation, project history, and extension usage views. This is an incremental improvement, not the complete accounting ledger described in the audit.

Each new settled step carries optional `accounting` evidence alongside the compatibility `cost` number:

- `reported`: a finite, nonnegative provider amount, its metadata field, and USD currency. Explicit provider-reported zero remains zero. Negative amounts, blank strings, booleans and nonfinite values fall back to the existing token calculation.
- `estimated`: measured token buckets with positive model rates. The record snapshots the applied per-million rates, disjoint normalized buckets, source provider/model identity and calculation version. It does not recalculate old records when the catalog changes. Context-tier selection continues to use the existing calculation.
- `partial`: a known calculated portion with missing usage or unverified bucket rates identified in `issues`.
- `unknown`: no verified priced usage, contradictory normalized counts, or a provider unit whose currency conversion has not been established in this record. Copilot nano-AIU values retain their unit and quantity; this evidence does not relabel them USD.

The existing reasoning-at-output-rate assumption remains visible as a separate reasoning bucket with its applied output rate. The snapshot source names the pricing model even when the step separately records a routed model.

The catalog currently normalizes omitted rates to zero. Consequently, a zero catalog rate is conservatively unverified in this increment; it cannot prove a model is free. Explicit provider-reported zero is supported. Verified zero rate cards need the next provenance increment.

## Aggregation and display

Session and project usage keep their existing numeric cost for compatibility and add an accounting summary. New summary amounts include evidenced USD amounts only. Status counts distinguish reported, estimated, partial, unknown and legacy steps. Aggregation reads each session's own step records, so propagated parent message costs do not double-charge child work.

The extension task header, model breakdown and project history label reported amounts and estimates, show an incomplete known portion when some evidence is missing, and display `Cost unavailable` instead of turning unknown zero into a free run. Legacy-only nonzero totals are explicitly labeled as having unavailable provenance. Very small nonzero amounts remain visible below the display precision.

Provider-reported amounts are not asserted to be invoice-final. These views cover settled model steps, not every separately billed tool or media charge.

## Remaining OVR-04 work

- Rate origins before catalog normalization, explicitly free rates, effective dates, refresh verification, trusted contract overrides and historical rate-card identities.
- Complete raw event identity and reconciliation, including retries, duplicate events, provisional usage and partial-stream termination.
- Provider-specific modality normalization, separately billed tools, realtime voice and transcription, plus independently priced reasoning where applicable.
- Full current-runtime and legacy-runtime coverage beyond this processor, and propagation of provenance into every CLI/TUI, budget, alert and export consumer. The compatibility numeric field retains its previous semantics.
- Validate raw metadata fallback buckets before normalization; this increment detects contradictions retained in normalized Usage and bucket totals, not every malformed adapter payload.
- Reconciliation between routed-model pricing, configured pricing, provider totals and invoice data. A source snapshot is evidence of the applied calculation, not proof that a rate applies to a contract.
- User-facing per-step calculation inspection and rate correction workflows.

## Verification

Focused tests exercise provider precedence and explicit zero, malformed provider amounts, missing rates, cache/reasoning partitioning, contradictory counts and non-currency provider units. Storage tests read persisted evidence back through the real session service and aggregate parent/child steps without message-cost duplication. The rendered usage view tests unavailable, reported zero, mixed reported/estimated, incomplete and tiny-amount states.

The DOM harness required normal-user execution because sandboxed esbuild directory traversal was denied twice. The same test passed outside the sandbox; no production code workaround was introduced for that restriction. The implementation progress log records final typecheck, lint, packaging and checkpoint outcomes.
