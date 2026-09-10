# Local work capability discovery

`discover_capabilities` is a bounded, read-only catalog for known local file, text-artifact, document/spreadsheet extraction, repository and chart operations. It accepts optional search words and a result limit of 1–10. The catalog has stable capability IDs, version 1, input formats, result types, permission categories and explicit limits.

Availability comes from the final tool selection sent to the model for that turn. The session resolver records known builtin definitions and their wrapped identities. Model-request preparation then binds the catalog after agent/session permissions, per-turn tool toggles and earlier Auto-phase filtering. An overwritten builtin name is not enough to claim the original capability. Scope is isolated per resolver; there is no persistent cross-session inventory or credential cache.

| State | Meaning |
|---|---|
| `available` | At least one known implementation is exposed in this model turn. Execution policy and resource readiness still apply. |
| `not-exposed` | None of the entry's known candidate tools is exposed in this turn. Discovery does not infer which configuration or permission caused that. |
| `unbound` | No final model selection was supplied. The catalog refuses to infer availability. |

Discovery never executes a tool, probes a provider, grants permission, installs software, reads files or authenticates an account. The existing tools retain their normal permission, sandbox, resource and execution checks. A tool can still fail or require approval after discovery. The network field describes the session restriction snapshot; it is not a guarantee of network access or destination approval.

## Initial catalog

- Read text; find paths; search local content.
- Create and edit text artifacts through the actually exposed write/edit/patch tools.
- Extract labelled XLSX/ODS values. This does not recalculate formulas, edit/export a workbook or establish cached-value freshness.
- Extract DOCX text. This does not create a Word document or validate page layout and embedded artwork.
- Inspect a repository with explicit commands through the configured shell. The compatibility tool name remains `bash`; discovery does not establish that Git or another executable is installed.
- Display a Chart.js chart where the chart tool is exposed. This is not an exported image, spreadsheet, PDF or slide artifact.

Auto's current orchestration allowlist remains unchanged. Discovery is usable by modes/delegated agents where its tool is exposed; it does not expand Auto's authority or bypass a restricted agent's permissions. Connected business-service tools, dynamic schemas, account readiness and remote file delivery are outside this initial catalog. An empty result is not a claim that Raya has no other tools.

## Verification scope

The focused fixtures exercise actual model-request filtering and the production discovery projection, including denied edits, disabled reads, overwritten names, missing bindings, untrusted context readers and separate resolver scopes. The local artifact workflow uses the real XLSX reader and writer to extract a generated workbook into a verified Markdown file, retaining the normal tool permission callbacks and file revision receipt. Only the external provider boundary uses a fixed fixture; no model generation is requested. The suite does not execute the full session resolver or prove a third-party connector, spreadsheet editor or recalculation engine works.

Validation results are recorded in the implementation progress log after the coordinated check batch. OVR-08 remains in progress: connected domain packs, deferred schema loading, artifact creation/export tools and broader real-work evaluations are still required.
