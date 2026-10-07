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

The decoder returns media segment timestamps, but catalog embedding publication and search remain attachment-level. Segment-vector storage, timestamped search results, audio conversion, OCR/transcripts, capture UI, installed endpoints and automatic media admission are still integration work. Inspection must run inside an externally owned process with memory and time supervision: checks between frames cannot interrupt a native decoder call. The trusted indexing caller must match the inspection hash against the approved catalog snapshot before publishing vectors. No personal media was imported during testing.

## Validation

The Bun test runs ten Python cases against real temporary files and SQLite: import/recall/forget, source revision snapshots, altered snapshot rejection, incompatible model rejection, atomic embedding batches, invalid vectors and limits, database path tampering, changed model metadata, full-catalog admission and locked-file deletion recovery. The Windows case opens a real handle that permits reading but denies deletion; no filesystem failure is mocked. A full catalog rejects new content before creating snapshots while allowing existing attachment titles to change; its existing search remains usable. SQLite serializes the count check and publication. This verifies storage behavior, not retrieval quality.

Run from `packages/kilo-vscode`:

```powershell
bun test tests/unit/memory-media-catalog.test.ts
```

The fixture currently uses the pinned local packaging Python runtime. An absent runtime is a test failure, not a skipped success.

Six additional real decoder cases passed separately using Pillow 12.3.0 and PyAV 19.0.1: valid image/content identity, invalid image signature payload, image size rejection, exact audio ranges, audio rate/duration/truncation rejection and a generated MP4 with decoded timestamps. These are synthetic media fixtures, not semantic retrieval or model inference. Decoder dependencies are pinned in `script/memory/media/requirements-media.txt`; they are not installed into the existing service by this commit. Run `tests/fixtures/memory_media_decode.py` with that isolated Python environment and pass `script/memory/media/library.py` as its argument.

A separate full-multimodal CPU smoke probe was aborted by its 6 GiB available-RAM guard after 26.97 seconds, before completing any modality. The sampled process peak was 3.61 GiB; minimum system available RAM was 5.99 GiB. Its original process exited and all observed owned children were joined. This is an incomplete test, not evidence that multimedia inference passed or that the model alone caused the system pressure. Keep the installed text-only switch separate from this deferred test.
