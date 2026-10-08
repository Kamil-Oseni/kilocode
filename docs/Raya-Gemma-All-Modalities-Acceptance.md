# Gemma acceptance across memory, code and media

Requested October 8, 2026: test every intended EmbeddingGemma 2 modality and its actual use inside Raya. A standalone model result does not prove a working installed retrieval consumer.

## Required acceptance

| Area | Required result | Current boundary |
|---|---|---|
| Text memory | Index and cache reuse, relevant preferences/projects, exact current sources, correction/deletion, authorized capture, ordinary worker shutdown | Full current synthetic index/search gate remains with the build chat; personal and installed capture acceptance remains open. |
| Codebase retrieval | Natural-language and exact-symbol queries find useful current functions/tests; return path, revision and line spans; edits/deletions invalidate old results; project and permission scopes are enforced | Actual-source benchmark executed: both query prompts find 5/8 expected functions first and 6/8 in the top three. Raw reserved-token strings require escaping. Dedicated code prompt dispatch and installed code-index consumer are unverified. |
| Images | Retrieve relevant screenshots, pictures and visual documents from paraphrased queries; exclude unrelated images; return an accessible current source | Older generated shape checks passed; realistic-media and current installed consumer acceptance remain open. |
| Audio | Retrieve spoken topics and relevant sound content; return the correct recording and timestamp; distinguish direct audio embeddings from transcript-assisted search | Older generated speech-topic checks passed; sound-content quality, realistic recordings and current installed consumer acceptance remain open. |
| Video | Find the correct clip and time range from varied visual and spoken queries; handle mixed audio/video evidence and source changes | Older synthetic visual-segment checks passed; mixed-media, temporal-quality and current installed consumer acceptance remain open. |
| Mixed retrieval | Text queries retrieve approved media across a shared compatible embedding space without confusing project/personal sources | Earlier small mixed-fixture results are preliminary; current integrated consumer is unverified. |
| Resource lifecycle | One heavy workload at a time; record cold/warm time, peak resident memory, minimum free RAM, cancellation/failure and ordinary process/stream closure | Keep the existing admission and shutdown requirements. A model or service being alive is not a passed test. |

Use relevant distractors and unrelated queries. Record ranks and false positives. Do not invent an abstention threshold from one small corpus or mark negative queries passed merely because a nearest neighbour exists. Verify saved source bytes before reporting a match. Indexes must respect exclusions and permitted roots; credentials and generated/dependency output must not become searchable code by default.

## Existing evidence and prepared inputs

- `D:/Raya/Models/Tests/GemmaMediaSemantic-20261006/semantic-results.json` records six generated image, six speech-topic and three synthetic video-range successes. Its original receipt records exit zero and joined cleanup. This is historical fixture evidence, not personal-media or installed acceptance.
- The same directory contains paraphrase, boundary, transcript and reranking results. Their source, relevance and scope must be checked before reuse. In particular, unrelated-query candidate scores are not calibrated rejection evidence.
- `D:/Raya/Models/Tests/GemmaAll-20261008/code-cases.json` pins six actual source files and their current bytes, 134 line-bound chunks, eight retrieval questions and three unrelated queries. The completed `code-results.json` records 135 token-bounded chunks, both prompt rankings and unrelated-query candidate scores. The run exited zero in 28.33 seconds with at least 11.39 GiB sampled free RAM. Preserve the source and line references; regenerate if file hashes change.
- `D:/Raya/Tools/Readiness-20261008/memory-gemma-live-acceptance-cases.json` contains the separate current personal-note cases; these remain unexecuted until the configured text path is admitted.

## Execution order

Finish the matching build/helper and current text service gate first. Then execute the source-grounded code and media evaluations sequentially, retaining failures rather than repeating an unchanged run. Integrate missing modality/prompt/index routes, and verify the installed source-to-search-to-answer/tool journey. Do not mark all modalities ready from a generated-media probe or a standalone embedding call.

The October 8 attempt to create a new standalone code runner was rejected by automatic approval review with only “blocked by policy.” No runner was created and no inference was started by that attempt. Do not bypass or delegate the rejected action.

## October 8 current-source multimedia run

`D:/Raya/Models/Tests/GemmaAll-20261008/media-results.json` records a fresh run against the current encoder/library: 6/6 image paraphrases, 6/6 speech topics, 3/3 video ranges, 6/6 mixed retrieval queries, and 2/2 long-audio ranges. Forgetting excludes the removed item. Original exec session 26528 exited zero with streams complete; 37.03 seconds, minimum sampled free RAM 15.01 GiB.

All ten unrelated queries still return candidates. Highest unrelated similarity is 0.60631, versus the weakest positive 0.61050; this small gap is not a calibrated rejection threshold. Generated fixtures establish functionality, not realistic personal-media quality or installed extension access.

## Evidence review and installed activation

The media review boundary separates supported, rejected and uncertain decisions and binds each verdict to the query, source bytes and recording span. Ten focused checks cover replay, changed or forgotten sources, invalid spans, duplicate candidates, ambiguous verdict JSON, exact-span WAV extraction and unavailable verifiers. These checks validate the boundary, not model judgment accuracy.

`D:/Raya/Models/Tests/GemmaAll-20261008/vision-verifier-results.json` records a finite Qwen 3.5 4B image check through the existing local Ollama API. The generated red circle on white was supported in 10.25 seconds; a blue-square-on-black query was rejected in 3.30 seconds. The rejected explanation nevertheless called the actual white background black. Correct binary verdicts in two cases do not prove reliable grounded explanations. The adapter is standalone and does not establish installed service ownership or settlement.

The video evaluator now samples up to three ordered frames within the exact selected span and supplies their recording timestamps. It can use a caller-owned exact-span transcription adapter for spoken video content. `D:/Raya/Models/Tests/GemmaAll-20261008/video-evaluator-boundary.json` verifies actual PyAV extraction of red, green and blue frames at 0.00, 0.33 and 0.67 seconds from a one-second clip. This is decoder evidence, not model judgment. Events between samples and unsupported sound claims remain uncertain.

`D:/Raya/Models/Tests/GemmaAll-20261008/video-verifier-results.json` adds two actual local Qwen3.5:4B judgment probes through the source evaluator: sampled solid red/green/blue supported in 6.13 seconds, unrelated person/dog/beach rejected in 3.69 seconds. The saved generated clip SHA-256 matches both verdicts. Original process exited zero; Ollama reported no resident models afterward. This remains generated-video adapter evidence, not real-world temporal accuracy, background-sound verification or installed ownership.

Before transcription, the evaluator decodes the selected audio/video span into mono 16 kHz PCM16 WAV. The caller receives only that clip, plus its `evidence_sha256` and the unchanged original source/query/span binding. `video-audio-evaluator-boundary.json` proves extraction of exactly 8,000 samples for a half-second selected range from an actual generated AVI audio track. The callback cannot accidentally transcribe speech elsewhere in the parent recording. Background-sound interpretation still requires a separate capable verifier.

`audio-verifier-transcript.json` records a real source-hashed generated speech fixture through the existing supervised Speech client: 2.52 seconds, accurate Eden feedback/campaign transcription, service active count zero afterward. `audio-verifier-results.json` records the evaluator consuming that exact source-bound transcript: the matching Eden query was supported and an unrelated fan-replacement query rejected, both with grounded transcript evidence, in 3.38 and 3.45 seconds respectively. These two cases establish adapter functionality, not general relevance accuracy, background-sound verification or installed media consumer ownership.

The old pre-index search failure is preserved in a quarantined audit; its historical shutdown remains unproven. Installed build `7.4.23-snapshot+1218cd9fd9.local.1791480260684` accepted an authorized fresh setup and reached `ready`. Ten eligible current notes were selected, but policy publication failed and indexing remains unconfirmed. Source commit e45ddde743 fixes the mixed CRLF/LF review comparison without changing the explicit approval or source-hash requirements. The fresh pair subsequently closed normally, with genuine closure receipt SHA-256 `ae991a151fada9508ec0a103d2b83716fa0f5774ad0b95e1f83f95e051da7d25`; this proves only that pair closed. Its saved launch still says running, so supported recovery must verify that receipt and process absence before a new launch. Personal indexing, recall and automatic capture are not accepted. Evidence: `D:/Raya/Models/Tests/GemmaAll-20261008/personal-memory-installed-observation.json`.

## Installed personal-text checkpoint

Build `7.4.23-snapshot+70948d94ea.local.1791482739982` recovered the genuinely closed fresh pair through its supported native recovery action. It preserved the old quarantined failure and credential reference, reached ready, approved ten eligible current notes and completed indexing; the native source policy reports synced. This supersedes the 1218 indexing failure for the new pair, without claiming that the historical quarantined pair closed.

Six actual panel queries found their expected voice, Sleep, second-PC, ambient-recording, deferred-model and FLUX facts. All 35 displayed source hashes across seven queries match current saved note bytes. The seventh query, about an absent blue passport, returned five irrelevant provenance passages without an unsupported/no-evidence status. Preserve that failure: the panel returned candidates, not a fabricated passport answer, but rejection is not accepted. Merely relabelling similarity matches cannot prove grounded chat answers or linked-context abstention.

Evidence is retained in `D:/Raya/Models/Tests/GemmaAll-20261008/personal-memory-native-recalls-709.json` (SHA-256 `10789e8d802ccd412d3fa0e9f1c2305b42b4f97c3d0e5f5db7491d368c51e97f`) and `personal-memory-native-recalls-709-source-check.json` (SHA-256 `785beb77ad088fe22596182ebfe2f72cfb0ed4950fa354317150975b9bf727ac`). These checks performed no device actions or recording activation. Capture is authorized but remains disabled and unverified in the installed service. Health.md remains excluded by the current picker, so do not claim all eleven planned sources were indexed.

## Clean media dependency handoff

`D:/Raya/Services/Retrieval/Candidates/GemmaMedia-20261008-root` contains a clean offline environment for the future separately selected media release. All 50 reused base wheels were checked against their manifest; Pillow 12.3.0, PyAV 19.0.1 and CPU torchvision 0.29.1 were checked against published PyPI/PyTorch hashes. The merged 53-package lock installed offline with required hashes, dependency consistency passed, and actual `EmbeddingGemma2Processor`/configuration imports passed in 5.24 seconds without model weights or inference. All selected module paths lie inside the new candidate; no external text-runtime `.pth` inheritance is used.

The dependency snapshot covers 23,923 files and 884,159,356 bytes; its manifest SHA-256 is `11850a89d96931d18c251f947f74b4fb367436047131c25533772d9f49989567`. `receipt.json` (SHA-256 `b7510d489e9b9bb84635fe05131dc7acdb56b2243547052cae947d9fd1fc4e97`) pins preparation, published wheel identities, imports and runtime inventory. The saved lock SHA-256 is `0dd090a5a330806fb593c2b6e2cfb6efe09a66212ce1a965196c6076c8a2bf53`; the first preparation digest was calculated before Windows newline serialization and was corrected against actual saved bytes. The previous receipt is preserved separately and is superseded. The candidate README preserves offline rebuild instructions. This is provisioning input, not protected execution admission, service activation or installed retrieval acceptance.
