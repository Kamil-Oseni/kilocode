# Local image runtime readiness

Updated October 8, 2026. FLUX is prepared as an isolated runtime, not an installed Raya image capability. Do not infer app readiness from the standalone results below.

## Verified model and runtime

- Model: `black-forest-labs/FLUX.2-klein-4B`, revision `e7b7dc27f91deacad38e78976d1f2b499d76a294`.
- Candidate: `D:/Raya/Services/Image/Candidates/FluxKlein-20261008`.
- Controlled Python 3.12.14; Torch 2.11.0+cu128, Diffusers 0.41.0, Transformers 5.19.0 and Accelerate 1.15.0.
- Dependency/import checks and an offline 46-package reconstruction passed. Those checks did not load weights.
- `generate-direct.py` loads the text encoder and image pipeline in separate phases with direct CUDA placement. The original `generate.py` remains unchanged. Comparative memory savings were not measured.

## Actual tests

| Test | Result | Measurements |
|---|---|---|
| 512px, four-step text-to-image | Generated and visually inspected an orange on blue fabric. | 37.25 seconds including imports/loading; 8.0 GiB peak Torch CUDA allocation; sampled minimum global free RAM 4.29 GiB. |
| 512px, four-step reference-image edit | Aborted at exit 42; no image produced. | 11.38 GiB starting free RAM; sampled minimum global free RAM 3.47 GiB triggered the 4 GiB reserve watchdog. |

Both tests used an explicitly authorized temporary graceful shutdown of the 2 GiB Home Assistant VM. The parent restarted it afterward, and its usual web URL returned HTTP 200. The model process exited and GPU memory was released. No shared Memory service or light commands changed.

The successful generation began with 11.69 GiB available RAM after an earlier 12 GiB admission refused 11.43 GiB. The direct-placement trial used an 11 GiB starting floor, a 4 GiB live abort reserve and a ten-minute deadline. This is a narrow measured trial, not a production admission policy. The reserve is sampled; it did not prevent RAM briefly falling below its threshold in the editing attempt.

## Evidence and recovery

- `generation-acceptance.json`, generation output `outputs/487eb178fa7e4df6acac40adaea41ec7/`, and `vm-assisted-generation-test.json`.
- `editing-attempt.json`, aborted output `outputs/e8ef2b808651452caa2f18902ad3548a/`, and `vm-assisted-editing-test.json`.
- Catalog: `D:/Raya/Models/Catalog/black-forest-labs--FLUX.2-klein-4B.json`. Production selection is false; editing acceptance is false.
- Offline wheels, hash-pinned requirements, controlled Python base and `restore.ps1` remain together in the candidate. Recovery instructions: `D:/RayaBackups/RECOVERY.md`. All copies are on this PC; off-PC recovery remains pending.

## Remaining integration

Image generation/editing needs a supported authenticated adapter, bounded jobs, actual cancellation/retirement, local reference admission and saved-image verification. Resource admission must account for conversation and other services. Do not automatically stop the Home Assistant VM, assume larger images fit, lower the abort reserve, or repeat editing under the same memory conditions.

Generation remains usable only within its demonstrated conditions. Editing, normal concurrent usage, larger resolutions and installed extension integration remain unaccepted. Keep the complete everyday implementation scope open.
