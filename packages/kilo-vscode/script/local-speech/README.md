# Local speech service

Versioned source imported from the installed Windows speech service on October 11, 2026. Credentials, logs, models and runtime state are excluded. Installation is a separate step; extension compilation alone does not update the external service.

`RAYA_SPEECH_ROOT` selects a private writable runtime directory for the access token, worker logs and allocated temporary folders. It defaults to the source directory for existing installations. `RAYA_SPEECH_CATALOG` selects the existing model catalog. The current fallback executable and default model cache locations retain their installed Windows paths.

Authenticated `POST /v1/jobs` with `kind: prepare`, `model: chatterbox-nano` and the catalog voice loads the actual CPU model and reference conditioning without input text, generated audio or fallback. It uses the same owned job IDs, queue, deadline, cancellation tombstones and result retention as synthesis. Cold preparation requires 7 GiB available RAM. Completion is required before listening may begin; cancellation never grants readiness. Idle retirement remains enabled.

Run `test_prepare.py` using the speech environment's Python. Set `RAYA_SPEECH_REAL_TEST=1` only after admitting an exclusive real-model RAM slot to qualify actual Nano preparation, subsequent inaudible synthesis and natural worker retirement. Default checks exercise production validation, authentication and pre-creation cancellation without loading models.
