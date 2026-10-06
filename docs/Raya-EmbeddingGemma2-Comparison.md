# EmbeddingGemma 2 comparison on RAYA-NODE-01

Date: 2026-10-06. Source checkpoint: `63fc2553d3`. This is an isolated CPU retrieval experiment, not installed Memory acceptance or a change to the configured index.

## Recommendation

Keep Qwen as the configured default for now and retain EmbeddingGemma 2 as a qualified lower-memory candidate. Gemma's warm embeddings and indexing are faster and its process RAM is lower, but first-result quality ties with improved Qwen after the existing reranker, and cold worker startup is slower. The current source retrieval supervisor retires its inference process after a request. A production switch should therefore qualify cold-query latency or safe bounded worker reuse before claiming faster everyday retrieval. For a later integration, retain the Qwen reranker and begin with full 768-dimensional text-only Gemma; image/audio encoders and automatic capture are separate work.

## Embedding results

The fixed corpus contains 44 documents: 20 representative synthetic setup notes, 12 deliberate distractors (including superseded plans), and 12 real source-function snippets. There are 40 memory queries and 24 code queries, with one predeclared intended document per query. Corpus and expected answers were written before inference; two inaccurate code-query descriptions were corrected against the actual source before the first successful run.

| Measurement | Existing Qwen runtime/config | Qwen matched runtime/code prompt | EmbeddingGemma 2 text-only |
|---|---|---|---|
| Correct first result | 43/64 | 47/64 | 50/64 |
| Memory first result | 30/40 | 30/40 | 33/40 |
| Code first result | 13/24 | 17/24 | 17/24 |
| Intended document in top three | 56/64 | 62/64 | 64/64 |
| Intended document in top five | 59/64 | 63/64 | 64/64 |
| Mean reciprocal rank | 0.790 | 0.846 | 0.888 |
| Warm median query time | 100 ms | 72 ms | 31 ms |
| Warm query p95 | 112 ms | 80 ms | 34 ms |
| Corpus embedding time | 4.86 s | 4.20 s | 2.10 s |
| Model load time | 3.40 s | 3.53 s | 4.70 s |
| Peak process working set | 3.77 GiB | 2.76 GiB | 1.83 GiB |
| Output dimensions | 1,024 | 1,024 | 768 |

The matched comparison uses the same Torch 2.14.1 CPU and Transformers 5.19.0 environment. Qwen keeps its actual production encoding implementation and gets a code-specific instruction for code queries; memory queries keep the existing personal-note instruction. Its original runtime uses Torch 2.6.0 CPU and Transformers 5.2.0. The additional Qwen variant was introduced after the initial runs to separate the current configuration from a better code-search instruction. This instruction change alone closes the first-result code gap; do not attribute every gain over the existing setup to model architecture.

Both models run float32, six CPU threads, batches of two and a 512-token window. Gemma uses the documented SearchQuery, CodeRetrieval and Document prefixes with vision/audio encoders disabled. Warm timings exclude the first query and include embedding computation, not service startup, indexing, authorization, network transport or reranking. Background desktop activity is not controlled; these are local directional measurements, not universal latency guarantees. All embeddings were checked for finite values and unit normalization.

Truncating Gemma vectors to 256 dimensions and re-normalizing produces 49/64 first results and keeps all 64 intended documents within the top five. It reduces memory-query first results from 33/40 to 31/40, so retain 768 dimensions for the initial integration. Truncation reranking and larger-corpus quality were not tested.

## Existing reranker and cold-query results

All three candidate lists were reranked using the exact same existing Qwen CPU reranker implementation, default personal-note instruction, original Torch/Transformers environment and five candidates per query. All 192 reranking operations succeeded within the 512-token limit.

| Measurement after reranking | Existing Qwen | Improved Qwen | Gemma |
|---|---|---|---|
| Correct first result | 55/64 | 57/64 | 57/64 |
| Memory first result | 35/40 | 35/40 | 35/40 |
| Code first result | 20/24 | 22/24 | 22/24 |
| Intended document in top three | 59/64 | 63/64 | 64/64 |
| Mean reciprocal rank | 0.885 | 0.930 | 0.938 |
| Median rerank time | 1.09 s | 1.19 s | 1.19 s |

Gemma brings every intended document into the candidate window, but that does not guarantee the reranker selects it first. Improving Qwen's code-query instruction closes most of the quality gap without rebuilding a vector index. The roughly one-second reranker dominates warm embedding time, so the 41 ms warm embedding saving is not a comparable reduction in whole conversational response time. Reranker peak working set was 3.77 GiB; replacing only the embedding model does not remove that separate peak.

An additional single-query diagnostic starts a fresh owned inference process, loads the model, embeds the same bedtime question and exits. In the matched environment, total launch-through-joined-exit took 6.89 seconds for Qwen and 7.74 seconds for Gemma. These include imports, initialization, encoding, serialization and exit; they are single observations rather than medians and exclude actual service admission/transport and reranking. Both had warm OS file caches. This confirms that faster warm computation should not be presented as faster cold service startup.

## Integration boundary

The current retrieval adapter validates the model identity, revision, normalized vectors and 1,024 dimensions. Gemma produces a different embedding space and 768 dimensions. Integration requires a model-aware adapter and a separately built index, with checks before switching and the old Qwen index available for rollback. Never mix embeddings from the two models, including truncated vectors.

Preserve source validation, restricted-source admission, review requirements, cancellation, RAM reserve, worker retirement and automatic-capture-off settings. This experiment directly invokes model implementations with a synthetic corpus; it does not certify those installed controls. It also does not test multilingual retrieval, media embeddings, 8K inputs, out-of-domain abstention, long-lived residency or a full personal-memory corpus. Related documents can answer parts of a query even when they are not its single intended gold document; scores reflect that strict target convention. Superseded-memory handling still requires metadata and freshness policy, regardless of model choice.

## Model identity and evidence

All local catalog-listed files were rehashed successfully: Qwen embedding 12 files, Qwen reranker 14 files, Gemma 15 files. Gemma's download is 1,525,810,123 bytes; disk download size is not inference RAM use.

- Qwen embedding: `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`.
- Qwen reranker: `e61197ed45024b0ed8a2d74b80b4d909f1255473`.
- EmbeddingGemma 2: `914f7f89142e33e77833254d9c9b90c3cef7303b`.
- Fixed dataset SHA-256: `97ab3bfe5abc361d2ddec3ab7af69b37105812191b634f0d8101fbbd35aee15e`.

Google describes the model's selectively loaded text encoder and retrieval prefixes in its [official Hugging Face model card](https://huggingface.co/google/embeddinggemma-2). Its [launch announcement](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) describes multimodal support. That additional capability remains untested here. Embeddings retrieve useful context; they do not enlarge a conversation model's generation context window.

Private working logs are in `.tmp/memory-private/embedding-comparison/`. Initial harness failures are retained: an oversized Qwen API batch was refused, and the new isolated environment initially lacked psutil and torchvision. The harness was corrected to send batches of two, and missing dependencies were installed only in the test environment. The final inference processes exited normally; original owned-process receipts verify joining and unloading. A six-GiB free-RAM reserve and a 15-minute per-process deadline supervised inference. CPU-only Torch allocates no model VRAM; unrelated applications' total GPU usage can change during the experiment.

All six final inference runs completed with no abort and no remaining owned PIDs. The minimum observed system free RAM was 6.10 GiB during the reranker run, above the six-GiB reserve. No Home Assistant, lights, ordinary microphone, personal-note index or configured service was changed. Downloaded weights and the isolated dependency environment remain on disk; inference models were unloaded by process exit.

Maintained evidence is saved in `docs/evaluations/embeddinggemma2-20261006/`: the fixed dataset, scripts, dependency versions, integrity checks, per-query results and original-process receipts. The private scripts originally ran under `.tmp/memory-private/embedding-comparison/`; archived scripts retain the same relative depth for root/source discovery. Reproduction needs the pinned local catalogs/checkpoints and the separate test runtime. It does not require importing or enabling personal capture.
