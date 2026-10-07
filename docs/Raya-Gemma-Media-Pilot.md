# Gemma media pilot and capture integration

The user authorized switching to EmbeddingGemma 2 and enabling automatic capture on October 6, 2026. The communicated scope is Raya conversations and actions. Ambient microphone and screen recording are not enabled by this instruction.

## Runtime handoff

The build chat owns the installed embedding service, model-aware admission, text reindexing, bounded worker reuse and automatic conversation/action capture. Preserve the Qwen index for rollback. Gemma uses 768-dimensional vectors at revision `914f7f89142e33e77833254d9c9b90c3cef7303b`; never mix these with the existing 1,024-dimensional Qwen vectors. The existing Qwen reranker accepts text only.

A reusable inference process needs separate evidence for completed requests and retired processes. A warm worker cannot produce a receipt claiming that its original process has exited. Keep one inference active at a time, bound idle residency, and retire owned workers under memory pressure, cancellation or service shutdown.

Capture must retain source identifiers and support correction and deletion. Exclude credentials and restricted sources. The user's authorization removes the earlier capture-off preference; it does not make unverified installed configuration changes complete.

## Source pilot

`packages/kilo-vscode/script/memory/media/library.py` provides an isolated catalog for explicitly selected files. It copies approved input into content-addressed snapshots and stores vectors in a separate revision-bound SQLite index. It does not scan directories or record devices. Caller-side admission and supervised decoding/inference are required before indexing.

The pilot accepts PNG, JPEG, WAV, AVI and MP4 signatures, up to 32 MiB per file and 128 cataloged attachments. Signature detection is not media decoding or a guarantee that a file is valid. Use a real bounded decoder before inference. Snapshots are published without overwriting existing files. Queries and publications require normalized finite 768-dimensional vectors and matching model metadata. Recall rechecks snapshot content and rejects changed index metadata or altered file addresses.

Deleting an original file does not delete its imported snapshot. `forget` first persists a tombstone that excludes the item from inventory, recall and new embeddings, then deletes the validated snapshot and finishes catalog cleanup. A locked file raises an error without claiming completed cleanup. Reopening the catalog keeps it hidden, and retrying `forget` finishes cleanup after the lock clears. Re-import is blocked during pending cleanup; explicit re-import after completion removes the tombstone. Repeated completed forgetting succeeds idempotently. Corrupted or externally modified snapshots fail validation; callers must preserve unexpected files for review rather than claim successful forgetting. Automatic startup reconciliation and complete multi-process admission remain integration work.

Returned matches include source path, import time, content hash and similarity. `inspect(path)` separately decodes an immutable bounded byte snapshot, validates its format and returns the same content hash. Images are limited to a single frame, 4 megapixels and 4,096 pixels on either axis. Audio currently accepts mono 16 kHz PCM16 WAV up to 60 seconds, with exact ranges of at most 30 seconds. Video accepts one video stream and at most one audio stream, with declared duration up to 30 seconds and decoded visual samples spaced at least one second apart. Pixel bounds, timestamp validity, a frame-count bound and an elapsed-time bound are checked. Embedded video audio is reported but not extracted or indexed by this function.

`publish_segments` accepts a complete recording/clip segment batch, validates its model space, file hash and exact decoded timestamps, and replaces the segment vectors atomically. `search_segments` returns ranked matches with the approved snapshot, origin and start/end range; selected results are decoded again to validate their timestamps, and forgotten items are excluded. The pilot limits publication to 32 segments per attachment and search to 4,096 indexed segments. Decoding selected clips during search is currently a performance cost, not a proven interactive path.

Audio conversion, embedded video audio extraction, OCR/transcripts, capture UI, installed endpoints and automatic media admission are still integration work. Inspection and segment search must run inside an externally owned process with memory and time supervision: checks between frames cannot interrupt a native decoder call. The trusted indexing caller must match the inspection hash against the approved catalog snapshot before publishing vectors. No personal media was imported during testing.

## Validation

The Bun test runs ten Python cases against real temporary files and SQLite: import/recall/forget, source revision snapshots, altered snapshot rejection, incompatible model rejection, atomic embedding batches, invalid vectors and limits, database path tampering, changed model metadata, full-catalog admission and locked-file deletion recovery. The Windows case opens a real handle that permits reading but denies deletion; no filesystem failure is mocked. A full catalog rejects new content before creating snapshots while allowing existing attachment titles to change; its existing search remains usable. SQLite serializes the count check and publication. This verifies storage behavior, not retrieval quality.

Run from `packages/kilo-vscode`:

```powershell
bun test tests/unit/memory-media-catalog.test.ts
```

The fixture currently uses the pinned local packaging Python runtime. An absent runtime is a test failure, not a skipped success.

Nine additional real decoder/segment cases passed separately using Pillow 12.3.0 and PyAV 19.0.1: valid image/content identity, invalid image signature payload, image size rejection, exact audio ranges, audio rate/duration/truncation rejection, a generated MP4 with decoded timestamps, timestamped recall after reopening followed by deletion, invalid/partial publication preserving the prior index, and altered stored timestamp rejection. These use synthetic media and controlled normalized vectors; they do not establish semantic retrieval or model inference. Decoder dependencies are pinned in `script/memory/media/requirements-media.txt`; they are not installed into the existing service by this commit. Run `tests/fixtures/memory_media_decode.py` with that isolated Python environment and pass `script/memory/media/library.py` as its argument.

An initial full-multimodal CPU smoke probe was aborted by its 6 GiB available-RAM guard after 26.97 seconds, before completing any modality. The sampled process peak was 3.61 GiB; minimum system available RAM was 5.99 GiB. Its original process exited and all observed owned children were joined. This remains incomplete historical evidence, not a passed test or proof that the model alone caused the system pressure. The later small-input result below uses the same reserve and does not erase this failure.

### Actual image encoder check

A later selective text/image run loaded 438,760,448 parameters with the audio encoder omitted. It used the pinned checkpoint, float32 CPU inference, six threads and a 512-token bound. Two generated 224-by-224 red/blue pictures were decoded, embedded, published through the actual catalog and retrieved correctly by their corresponding text queries. Image encoding took 2.41 and 2.48 seconds; the two text-query-plus-catalog searches took 76 and 73 milliseconds. This is a two-color smoke test, not a photorealistic, document or general visual retrieval evaluation.

The original probe exited naturally with code zero after 13.61 seconds; no observed owned child remained. Sampled peak process RAM was 2.51 GiB and minimum system available RAM was 11.32 GiB. Inference used CPU, not CUDA. The test imported no personal data and left the installed services unchanged. All 15 cataloged checkpoint files were subsequently rehashed, matching all 1,525,810,123 bytes. Scripts, results, lifecycle/resource receipt, the earlier aborted full-media receipt and integrity record are retained under `docs/evaluations/gemma-media-20261006/`. Source hash in the result identifies the catalog code tested; later source revisions need their own qualification.

### Full small-input encoder smoke test

After system headroom improved, a new original process completed image and audio inference but failed on path-based video loading: Transformers expected `torchcodec`, which was not installed. That failed process exited with code one and was joined; its source, log and resource receipt are preserved. Instead of changing installed codec dependencies, the successor supplied two PyAV-decoded RGB frames and explicit original frame indices/FPS metadata, with additional processor frame sampling disabled.

The successor loaded 744,371,488 parameters in 2.80 seconds and produced finite normalized 768-dimensional embeddings for all three synthetic inputs: a 224-by-224 red picture (2.45 seconds), one second of mono 16 kHz tone audio (0.45 seconds), and two sampled frames from a two-second red clip (2.33 seconds). It exited naturally with code zero after 14.90 seconds and left no observed owned child. Sampled peak process RAM was 3.70 GiB; minimum system available RAM was 9.65 GiB. The same 6 GiB reserve remained active.

This proves these small input paths run on this PC under the observed load. It does not measure speech understanding, personal media recall, long recording/clip quality, semantic audio/video search or installed service acceptance. The checked-in `full_media_pyav_probe.py`, results and receipt retain the actual finite experiment. The user-authorized installed Gemma migration, bounded reuse and automatic capture still require their own verification.
