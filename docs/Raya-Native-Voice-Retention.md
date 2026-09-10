# Native voice record retention

Native OpenAI voice records belong to their parent task. The backend stores each binding, its capability hash, work-call receipts, staged image bytes, and provider-usage receipts in `raya_voice_binding`. A foreign key to the parent session removes that row when the task is deleted. Ending voice closes its binding; it does not delete the task's retained records.

New binding creation requires an existing parent. Later writes update an existing row; they never insert a replacement. This prevents a delayed work result, image upload, or usage write from recreating a binding after task deletion. The existing capability, generation, directory, and live-owner checks still apply. Restarted backends do not adopt or repeat old work.

## Older installations

Older versions wrote JSON records in `storage/raya_openai_voice`. Reading a legacy record migrates it into the parent-linked table while preserving its identity and retained contents. SQL is authoritative when both copies exist. A missing parent prevents import. Migration removes the old copy only after successful persistence, or after establishing that the parent no longer exists.

Deleting a task first checks legacy records and removes those owned by that exact parent, including recognized `.review-*.tmp` publication remnants. It preserves records owned by other tasks. Missing files are safe to retry. Unreadable records, unidentifiable ownership, and unexpected record types stop deletion rather than claiming successful erasure. Diagnostic errors omit record contents. If an earlier step removed some legacy files before another failed, retrying deletion is safe; deletion across multiple legacy files is not transactional. Recursive task deletion is also not atomic: an earlier child may have been deleted when a later child fails, and that failure is returned to the caller.

The database cascade and update-only writes protect the current backend. An older backend process that still writes the former JSON format can recreate legacy files after cleanup; stop older instances before relying on complete cleanup. This change does not force an editor reload or terminate other installations.

## Scope and limits

These are logical record-deletion guarantees, not forensic secure erasure. Existing database backups, SQLite recovery files, operating-system backups, exports, and provider-side retention have separate lifecycles. Migration backups may contain older task data. No age-based purge or maximum aggregate history retention is introduced here.

Native audio is not saved by this record store. Captions remain connection-local; durable spoken-transcript recovery is still separate work. Images already attached to ordinary task messages follow the ordinary task lifecycle. Closing a voice call retains its receipts until the parent task is deleted.

Verification covers actual fresh and upgraded databases, foreign-key enforcement, unrelated-task preservation, service persistence and migration, and the shipped authenticated task-delete and voice endpoints. Live microphone and paid-provider acceptance are not part of these local checks.
