# Recovery verification and remaining work

Reviewed 2026-10-05 against the saved recovery records and current local launcher source. This supplements `D:/RayaBackups/RECOVERY.md`; it does not authorize a restore or restart.

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
