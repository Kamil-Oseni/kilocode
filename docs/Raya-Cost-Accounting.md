# Raya cost accounting

## Implemented increment

OVR-04 now has a first persisted provenance path through the existing session processor, step storage, generated API/SDK, session-family aggregation, project history, and extension usage views. This is an incremental improvement, not the complete accounting ledger described in the audit.

Each new settled step carries optional `accounting` evidence alongside the compatibility `cost` number:

- `reported`: a finite, nonnegative provider amount, its metadata field, and USD currency. Explicit provider-reported zero remains zero. Negative amounts, blank strings, booleans and nonfinite values fall back to the existing token calculation.
- `estimated`: measured token buckets with positive model rates or evidenced explicit zero rates. The record snapshots the applied per-million rates, their catalog/configuration origin when available, disjoint normalized buckets, source provider/model identity and calculation version. It does not recalculate old records when the catalog changes. Context-tier selection continues to use the existing calculation.
- `partial`: a known calculated portion with missing usage or unverified bucket rates identified in `issues`.
- `unknown`: no verified priced usage, contradictory normalized counts, or a provider unit whose currency conversion has not been established in this record. Copilot nano-AIU values retain their unit and quantity; this evidence does not relabel them USD.

The existing reasoning-at-output-rate assumption remains visible as a separate reasoning bucket with its applied output rate. The snapshot source names the pricing model even when the step separately records a routed model.

Rate presence and origin are now captured before catalog normalization substitutes zero. Explicit catalog and configured zero rates can support a zero estimate; absent rates remain unpriced. The stored evidence must match the effective rate, so stale evidence cannot turn a later zero into a confirmed price. Existing positive rates without origin evidence remain usable as estimates and are labeled accordingly. Model names and a missing monetary total never imply free usage.

Model modes inherit omitted cache prices from their base. Supplied context tiers and over-200k pricing replace their evidence together, preventing deep merges from attaching an older tier's zero-rate evidence to an omitted price. Configured overrides preserve the origin of unchanged inherited buckets.

## Aggregation and display

Session and project usage keep their existing numeric cost for compatibility and add an accounting summary. New summary amounts include evidenced USD amounts only. Status counts distinguish reported, estimated, partial, unknown and legacy steps. Aggregation reads each session's own step records, so propagated parent message costs do not double-charge child work.

The extension task header, model breakdown and project history label reported amounts and estimates, show an incomplete known portion when some evidence is missing, and display `Cost unavailable` instead of turning unknown zero into a free run. Legacy-only nonzero totals are explicitly labeled as having unavailable provenance. Very small nonzero amounts remain visible below the display precision.

Provider-reported amounts are not asserted to be invoice-final. These views cover settled model steps, not every separately billed tool or media charge.

The task usage disclosure shows stored per-step amounts, pricing model, token buckets, rates, origins and missing information for the loaded conversation. It starts with twenty recent steps and allows earlier calculations to be expanded. Related-conversation totals can include steps not loaded in this view; the disclosure names that scope. Historical project queries enforce both inclusive start and end boundaries, including the end boundary for the All range.

## Remaining OVR-04 work

- Effective dates, refresh verification, trusted contract overrides and historical rate-card identities. Declared catalog/configured rate presence does not prove current contract applicability.
- Complete raw event identity and reconciliation, including retries, duplicate events, provisional usage and partial-stream termination.
- Provider-specific modality normalization, separately billed tools, realtime voice and transcription, plus independently priced reasoning where applicable.
- Full current-runtime and legacy-runtime coverage beyond this processor, and propagation of provenance into every CLI/TUI, budget, alert and export consumer. The compatibility numeric field retains its previous semantics.
- Validate raw metadata fallback buckets before normalization; this increment detects contradictions retained in normalized Usage and bucket totals, not every malformed adapter payload.
- Reconciliation between routed-model pricing, configured pricing, provider totals and invoice data. A source snapshot is evidence of the applied calculation, not proof that a rate applies to a contract.
- Paginated server-ledger inspection across every related conversation and rate correction workflows.

## Verification

Focused tests exercise provider precedence and explicit zero, malformed provider amounts, missing rates, cache/reasoning partitioning, contradictory counts and non-currency provider units. Storage tests read persisted evidence back through the real session service and aggregate parent/child steps without message-cost duplication. The rendered usage view tests unavailable, reported zero, mixed reported/estimated, incomplete and tiny-amount states.

Provider-service tests use the checked-in catalog to verify configured zero overrides retain omitted catalog cache prices and their origins. Mode tests exercise actual accounting above 200,000 input tokens for both inherited and replaced context pricing. The disclosure fixture checks rate origins, missing cache pricing and expansion beyond twenty loaded steps.

The DOM harness required normal-user execution because sandboxed esbuild directory traversal was denied twice. The same test passed outside the sandbox; no production code workaround was introduced for that restriction. The implementation progress log records final typecheck, lint, packaging and checkpoint outcomes.
