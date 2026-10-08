# Memory deployment handoff — October 7

## October 8 current integrated source bundle

For current provisioning, the staged successor is `D:/Raya/Services/Packaging/Candidates/Reuse-d44-current-20261008-root/sources.zip`: 107,231 bytes, SHA-256 `c9dfce7df44d798f95e0f07b93254b4493724a740a9a3acb5cd520f94e6027d5`. Its receipt selects integrated commit `ca93b495ff33518ec205745eb9f03fcd12ba880f` and reusable fingerprint `366c881ade5833f36eb3002e530b7b56c9f114dc3ad62f2314b4204d0077834b`. All 33 archive entries were read back against the staged bytes. Twelve Memory files match the current supervisor release map, sixteen Retrieval files match the supervisor and extension reuse catalog, and three checkpoint catalogs match current pins. The current supervisor is included. The clean dependency candidate below remains selected staging input.

This supersedes the older bundle and fingerprint below only for source provisioning. It does not establish protected interpreter/dependency admission, deployed service readiness, Gemma index migration, warm reuse or automatic capture. Those deployment checks remain required. The older input table is retained as historical evidence; use the successor fingerprint for both current cohort release selections.

The source is ready for integration into the matching release. Successful installed Gemma retrieval, bounded warm reuse, and automatic Raya capture remain unverified. Keep the existing service available until the new cohort passes its deployment checks.

## Inputs

| Input | Selected artifact |
|---|---|
| Extension source | `codex/raya-everyday-experience` through `95e9098bb4` |
| Service source bundle | `D:/Raya/Services/Packaging/Candidates/Reuse-03e5784639/sources.zip` |
| Bundle SHA-256 | `c711288f9ddd2324e20c958a33fcc0f63f7ac2e91fe2c8118447cc2169d201ba` |
| Reusable source/catalog fingerprint | `3b55eb2b3dee4e08913382792bfcfa6f0956624a89071754ee5508205dc6814d` |
| Clean dependency staging | `D:/Raya/Services/Retrieval/Candidates/GemmaText-20261006-root` |
| Dependency inventory SHA-256 | `d2d6de6f5af6b69dd27b48607cba41614491612cb373c9eaab8780b617eae705` |
| Gemma checkpoint revision | `914f7f89142e33e77833254d9c9b90c3cef7303b` |

The bundle contains 33 source/catalog/manifest entries, no credentials, interpreter, dependencies or weights. Its receipt records the service-source commit; the later extension-only protocol fix leaves these service bytes unchanged. Copy staging inputs into the selected protected cohort through the existing provisioning path. The archive receipt does not authorize execution or certify native protection.

## Cohort selection

1. Select the paired version 2 managed descriptor with separate Memory and Retrieval plans and the shared exact asset inventory.
2. Select Retrieval protocol `raya.retrieval.request.settlement.v2` in its plan and `RAYA_MEMORY_RETRIEVAL_PROTOCOL` in Memory. Select the fingerprint above with `RAYA_RETRIEVAL_RELEASE_SHA256` and `RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256` respectively. The reusable source root contains both `retrieval/` and `retrieval_reuse/`; Memory has its own `source/memory/` directory.
3. Select Memory operation protocol `raya.memory.operation.v2` in the client setup. Preserve the original managed owner and stream handles; health metadata cannot replace them.
4. Set `RAYA_MEMORY_EMBEDDING_MODEL=embeddinggemma-2` in Memory indexing. Use `search-embeddinggemma-2.sqlite` with 768-dimensional vectors. Preserve `search.sqlite` and the `qwen3-embedding-0.6b` 1024-dimensional selection for rollback. Do not mix vector dimensions or overwrite the rollback database.

## Deployment checks

Reuse existing source, codec, real SQLite, native-owner and no-inference lifecycle evidence for unchanged code. Perform the following on the matching deployed cohort:

- Confirm authenticated readiness, selected epoch/release and original owner health.
- Complete a real embedding through paired Memory, then a second request through the same admitted worker/model. Save latency and sampled RAM; keep the 6 GiB free-RAM reserve. The earlier live reusable attempt aborted on reserve pressure, so successful loading remains a release gate.
- Confirm cancellation and idle unloading settle through the retained original handles. Confirm drain/resume preserves the service epoch without replaying canceled requests.
- Rebuild the separate Gemma index and retrieve representative preferences/projects with correct source references.
- Enable the authorized automatic capture of Raya conversations/actions and verify a saved update, correction and removal. Ambient screen/microphone capture remains disabled.

These are deployment gates, not a request to repeat every source test or copy/ACL experiment for a documentation or TypeScript-only correction. If a model run is refused or aborts, retain the failed evidence and leave the current service selected until the cause is resolved.

## Rollback

Keep a copy of the prior descriptor, client setup, admitted cohort selection and database before switching. If acceptance fails, stop the new cohort through its retained original owner and verify settlement before selecting the prior descriptor/setup and Qwen database. An observation timeout does not prove shutdown or allow replacement of an uncertain original owner. Retain the new index and failure reports for investigation; rollback does not delete personal notes.

Detailed source contracts and evidence paths remain in [Raya-Retrieval-Worker-Reuse.md](Raya-Retrieval-Worker-Reuse.md) and [Raya-Gemma-Text-Adapter.md](Raya-Gemma-Text-Adapter.md). The build chat owns cohesive installed provisioning and acceptance.
