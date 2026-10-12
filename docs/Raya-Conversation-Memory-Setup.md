# Conversation-first Memory setup

The new source flow starts from an explicit conversation request or the Memory view's **Set up with Raya** action. It reuses the existing Ask cards and does not write setup text into an existing draft. Offline, the action stays disabled and explains that Raya must connect.

`second_brain_recall` accepts `{action:"setup"}`. The backend passes the actual turn's model internally; model-facing arguments cannot supply credentials, runtime paths or model selections. The host returns an attempt ID and one missing decision at a time. Continuation and cancellation stay bound to the original conversation, project and prepared selection.

The stages are connection or fresh recovery, note selection, indexing and automatic-saving consent. Completed stages are preserved. Existing configuration and authorization are reused when valid. A configured but unusable earlier generation goes through the existing reviewed recovery flow before note selection; its prior request debt and audits are retained. No original request is replayed.

Credentials remain in the existing masked native input. Native runtime, source and saving approvals retain their existing boundaries. The saving stage uses the actual runtime binding and selected conversation model. Original cancellation and scope checks reach the final consent publication boundary.

## Installer handoff

The host reads `<globalStorageUri>/memory-prepared.json`. This public candidate registry contains no credentials or approval authority. It references bounded, hash-pinned metadata using `{path,bytes,sha256}` records:

```json
{
  "format": "raya.memory.prepared.setup",
  "version": 1,
  "fresh": {"path": "<reviewed fresh selector>", "bytes": 1, "sha256": "<64 lowercase hex characters>"},
  "control": {"path": "<reviewed control catalog>", "bytes": 1, "sha256": "<64 lowercase hex characters>"}
}
```

The values above are shape examples, not runnable configuration. An initial prepared runtime uses `setup` and `managed` references instead of `fresh`. An optional `capture` reference carries separately reviewed choices. Registration and consumption validate exact metadata and runtime/catalog compatibility before selection. Changing the candidate during a setup attempt refuses continuation.

The supported command `raya.memory.registerPreparedSetup` can validate and publish a registry. An installer may publish the same public candidate file; this does not write VS Code Memento, grant access, enable capture or start a service. The current PC's durable registry is prepared under `D:/Raya/Services/Memory/Prepared/raya-memory-prepared-04078c43015d41b2bbd61cfb2bb8192d/registry.json`.

## Current evidence and limits

Focused backend, host-flow, question-builder and DOM checks pass. Extension host/webview types, lint, bundle, Knip and the marker guard pass. The SDK was regenerated through the repository generator. An initial lint failure and a helper-shadowing type failure were fixed; their failed checks were not counted as passes.

This source is not yet installed. Full CLI typechecking and the installed conversation journey remain pending. A `configured` receipt reports observed setup state and explicitly leaves conversational saving and recall unverified. A machine without a prepared runtime receives an honest `needs_attention` result; a generic runtime downloader/provisioner is not implemented by this change.

Installed acceptance should exercise setup without technical filename entry, a newly saved preference and later source-backed recall, cancellation, correction, forgetting and pausing. Voice testing remains deferred at the user's request. No personal notes, grants, credentials, runtime services, models or physical lights were changed while developing this feature.

## Conversational saving controls

The next source change supports explicit pause and resume requests through the same Memory tool. Pause changes only the saved intake preference; it does not start a service, remove notes, clear grants, discard uncertainty or claim that earlier writes were cancelled. Resume reuses the admitted preferences and requires native approval after checking the actual current binding.

Receipts and the settings view distinguish whether future saving is enabled from an earlier save's observed status. A paused future preference can therefore coexist with a running or uncertain original save. Setup reports these unfinished or capacity-limited states as needing attention rather than completed setup. Source checks pass; installation and actual conversational control acceptance remain pending.
