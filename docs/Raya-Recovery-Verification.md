# Recovery verification and remaining work

Reviewed 2026-10-05 against the saved recovery records and current local launcher source. This supplements `D:/RayaBackups/RECOVERY.md`; it does not authorize a restore or restart.

## October 6 recovery update

`D:/RayaBackups/RECOVERY.md` now points to the verified October 6 `c1dce02b` lighting backup and the bounded 7149 rollback vault. Its previous bytes are preserved in `D:/RayaBackups/Independent-20261005/RECOVERY-before-20261006.md`. The lighting export contains `script.sleep_mode_fade` with the ceiling off first and excluded from the 540-step fade. The current vault contains eight hash-verified archives; all eight packages from before rotation and the byte-exact index remain in `D:/RayaBackups/PackageVault-20261006-before-7149-exact`. The earlier backup folder’s reformatted index is a logical record only. No live restore, registry replacement, reinstall or reboot was performed. See [current readiness](Raya-Current-Readiness.md) for installed-workflow limits.

## Separate the restore checks

The saved `D:/RayaBackups/Independent-20261005/final-verification.json` records a completed isolated **file-copy rehearsal**: 145 snapshot files matched after copying into the rehearsal folder, nine curated notes matched their curated snapshot, and no missing local links were recorded. It explicitly records no live restore, no Home Assistant restore, no model/service startup and no automatic capture.

The current checklist's single pending “isolated restore rehearsal” entry should therefore be split:

- Completed within its recorded scope: copy and hash-check the saved files in an isolated rehearsal folder and check curated note links.
- Pending: restore Home Assistant into an isolated VM and verify recovered configuration/Matter data without operating a second controller on the household network.
- Pending: demonstrate accepted local-service reconstruction and semantic retrieval through the installed lifecycle owner. Copying source files or matching their hashes does not prove this.
- Pending: verify startup after a controlled reboot and choose an off-PC backup destination.

The saved file-copy result is historical evidence. It does not certify newer live notes, the latest extension package, portable credentials or a complete software installer.

## Distinguish graceful recovery from forced retirement

The current `D:/Raya/Services/runtime.py` checks ownership, refuses active work and obtains an idle drain lease before retirement. However, `retire()` terminates the owned process tree, waits five seconds, kills remaining processes, and waits another five seconds. This manual launcher must not be described as proof of graceful natural shutdown, immediate cancellation or installed recovery acceptance.

Use the accepted installed lifecycle owner for ordinary recovery. If exceptional manual launcher recovery is selected, verify the owner and idle state first, preserve the diagnostic result, and disclose any forced termination. Do not infer that a successful launcher exit proves all work and streams finished naturally.

These findings require checklist and guide updates when consolidated. They do not promote the full recovery requirement to complete.

## Current PC reliability observation

A fresh read-only check found Home Assistant's HTTP origin returning 200 and the VirtualBox VM running with 2,048 MiB, two CPUs and bridged networking on the Intel Wi-Fi adapter. The enabled Home Assistant startup task uses a logon trigger with a 45-second delay; its last result is zero. This supports current availability and configuration, not a successful controlled reboot rehearsal.

The active Windows Balanced plan has AC sleep and hibernation timeouts set to zero. DC sleep remains ten minutes. The temperature task is running. The RGB bridge task is enabled with a 30-second logon delay, but its last result is 267014 (`0x41306`, task terminated) and it is currently Ready. Task state alone does not establish whether a separately started bridge is alive or whether Home Assistant's PC RGB entity is available.

The recent System log contains Kernel-Power 41 and EventLog 6008 at the October 4 unexpected shutdown. The selected Kernel-Power fields report bugcheck code zero, no sleep in progress and no recorded power-button timestamp. Those fields do not identify the cause or prove the earlier virtual-machine clock stalls are fixed. No power plan, task, VM, service or light was changed during these observations.

Follow-up resolved the RGB availability uncertainty: listener PID 8588 belongs to the expected bridge command, and read-only OpenRGB packets for protocol version, device count and current device data all received valid responses. The refreshed Home Assistant bedroom dashboard displays **PC RGB 34%**, rather than unavailable. The initial browser page showed stale connection-loss notices; reloading and opening the bedroom dashboard restored the current view. No RGB write packet, mode activation or restart was used. This proves present bridge/dashboard availability, not startup recovery after a reboot.

## Matching package installation

The `7.4.23-snapshot+ddccef1e67.local.1791249931251` installation finished naturally, with its original installer process and streams joined. The completed before/after checks report exact profile contents, unrelated extension payloads and unrelated registry entries. The sampled process/window monitor finished without a disallowed writer; it does not prove that actors shorter than its sampling interval never appeared.

The independent installed audit compares all 479 payload files against the reviewed archive. The package manifest is semantically identical after allowing VS Code installation metadata, and the additional `.vsixmanifest` is byte-identical to the archive manifest. This is file-integrity evidence, not proof of a loaded version, rollback execution or successful recovery of drafts, routines and running work. Preserve the distinction: the integration review currently reports a draft-save warning after reopening, so restart recovery remains pending.

## Preserve the revised sleep routine after recovery

The October 5 Home Assistant edit changes **Nightly sleep wind-down**: turn `light.bedroom_ceiling_light` off immediately with `transition: 0`, then fade only `light.smart_rgbtw_bulb`, `light.bedroom_left`, `light.bedroom_right` and PC RGB. Keep the daily 21:00–22:30 schedule and the final all-off action. The saved editor was reloaded before running the routine; subsequent dashboard observations showed the ceiling off while the remaining lights continued dimming.

The earlier file-copy rehearsal does not prove that a Home Assistant backup contains this newer edit. After an isolated restore, inspect the automation before reconnecting the restored controller to the household network: the immediate ceiling-off action must precede the fade, and the ceiling must be absent from the repeat's `for_each` list. It can remain in the final all-off target. Compare configuration without running the automation or operating duplicate Matter controllers. A restored older backup needs this edit reapplied before it matches the current requested behavior.
