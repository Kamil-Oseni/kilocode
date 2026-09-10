# Routing selection safety: first OVR-03 slice

This increment preserves selected model and provider identities during Auto orchestration and task delegation. It does not replace the role-ranking algorithm or demonstrate better routing quality on held-out tasks.

## Selection contract

| Source | Behavior |
|---|---|
| Explicit `agent.auto.model` | Retain the exact model. It overrides `small_model`; refreshing the specialist registry cannot overwrite it. |
| Configured `small_model` for Auto | Retain the exact model. Missing or incompatible selections produce a visible error. |
| Implicit Auto with a non-Kilo parent provider | Use the exact requested parent model. Do not send the Chief request to another provider. |
| Implicit Auto with a Kilo parent provider | Prefer `kilo-auto/small`. An application-selected fallback may use another compatible model within Kilo only. |
| Task workflow override | Highest-priority exact selection. |
| Saved CLI per-agent picker | Next-priority exact selection; an unavailable saved model does not fall through to another provider or agent configuration. |
| Agent model, generalist `small_model`, configured `subagent_model` | Preserve existing precedence and use the first configured choice exactly. |
| Task parent model | Use it exactly when no higher-priority selection exists. |

An explicit configuration may intentionally choose a different provider from the parent. That is an authorized selection, not a recovery fallback. An unavailable explicit selection does not authorize another model, even within the same provider.

Explicit model-specific variant overrides and selected variants are validated against the chosen model. An unavailable variant produces an error instead of silently reducing reasoning effort or dropping the variant. The existing `default` value retains its no-override meaning. A parent's variant remains associated with the parent's model when a separately configured Chief model is used; the parent selection is retained in routing metadata for delegation.

Malformed saved CLI model-state files retain their existing parse-failure behavior. This increment protects valid selected references; it does not redesign saved-state corruption recovery.

## Dispatch and side effects

Agent discovery retains configured references without resolving Auto's model eagerly. An invalid Auto configuration therefore does not prevent ordinary agent listing or use of another agent.

Auto performs a selection preflight before revert cleanup or interrupted-message recovery. It revalidates immediately before user-message persistence, covering direct command paths as well. A refusal leaves the submitted input unchanged and does not change the active routing request, permission rules or existing messages. The existing session error channel carries the explanation. Direct Auto continuation validates the exact persisted model and variant before interrupted-message recovery, then revalidates before each resumed dispatch. A changed configuration does not replace that persisted selection.

Task model selection occurs before creating a child session or refreshing an existing child's permissions, sandbox inheritance and metadata. A refused selection does not dispatch the child prompt or consume a pending Chief decision. Existing task authorization remains required; this model guard does not grant tool permission.

`RayaModelSelectionError` is an internal typed error with the selected provider/model and a finite reason: missing model, unsupported tools, unrecognized capability flag or unavailable variant. Existing session/tool error text exposes the explanation. There is no new endpoint or public SDK error schema.

## Capability and evaluation limits

The guard accepts a normalized provider `toolcall === true` flag. Provider ingestion currently defaults some absent catalog/config fields to true. This increment therefore does **not** prove that the original metadata explicitly declared tool support, probe a model, establish provider availability or certify a data destination. An accepted flag can still be wrong; ordinary provider failure remains possible.

The implicit Kilo fallback uses existing recency/context ordering with a stable model-ID tie-break. That ordering is only a deterministic compatibility choice. It is not measured task quality, a calibrated confidence score or a cost optimization claim. Provider health, original metadata provenance, richer route receipts, direct-response routing and held-out comparisons remain open OVR-03 work.

## Verification

Targeted tests exercise the real Provider and Agent services, actual Task execution with real retained sessions, and actual Auto prompt intake. Cases cover exact selections, configured override precedence, same-provider implicit fallback, refusal before child mutation, retained parent messages and routing state, variants, and the normalized-metadata limitation. The corrected combined run passed 37 of 40 cases (138 assertions); three Provider cases exceeded the existing five-second deadline while CLI types ran concurrently. An isolated rerun of the affected Provider file passed all 12 cases (21 assertions, 38.53 seconds, native exit 0). All 22 Task and six Auto cases, including both direct-continuation refusals, passed in the combined run. This is passing coverage across focused runs, not a claimed all-green aggregate. Final CLI types passed with native exit 0. Logs: `.tmp/routing-selection-tests-verified.log`, `.tmp/routing-selection-provider-isolated.log`, `.tmp/routing-selection-types-final.log`.

The initial fixture run failed because service layers omitted the real process spawner and assertion callbacks returned void to Effect.tap; both fixture defects were corrected. The initial type runs also caught branded expected-value mismatches, now corrected with the actual ID constructors. Failed logs remain retained; no production timeout or selection guard was relaxed.

The audit's earlier malformed-tool recovery concern is already corrected in the current runtime: Auto does not invent a delegation call when an unknown tool fails. The separate actual AI SDK regression covers that existing boundary; this increment does not claim to have newly implemented it.
