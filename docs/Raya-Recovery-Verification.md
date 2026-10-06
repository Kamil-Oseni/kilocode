# Recovery verification and remaining work

Reviewed 2026-10-05 against the saved recovery records and current local launcher source. This supplements `D:/RayaBackups/RECOVERY.md`; it does not authorize a restore or restart.

## October 6 recovery update

`D:/RayaBackups/RECOVERY.md` now points to the verified October 6 `c1dce02b` lighting backup and the bounded 7149 rollback vault. Its previous bytes are preserved in `D:/RayaBackups/Independent-20261005/RECOVERY-before-20261006.md`. The lighting export contains `script.sleep_mode_fade` with the ceiling off first and excluded from the 540-step fade. The current vault contains eight hash-verified archives; all eight packages from before rotation and the byte-exact index remain in `D:/RayaBackups/PackageVault-20261006-before-7149-exact`. The earlier backup folder’s reformatted index is a logical record only. No live restore, registry replacement, reinstall or reboot was performed. See [current readiness](Raya-Current-Readiness.md) for installed-workflow limits.

The guide also records the physically verified 58ab installation and the exact pre-upgrade rollback snapshot at `D:/RayaBackups/PackageVault-20261006-before-58ab-exact`. All eight archives and the original index were independently rehashed (1,523,496,799 bytes). This is a recovery snapshot, not a tested restore. The installation monitor failure remains explicit; physical payload and point-in-time preservation checks do not certify continuous writer exclusion or normal loaded workflows. The prior guide is preserved as `D:/RayaBackups/Independent-20261005/RECOVERY-before-58ab-update-20261006.md`; the updated guide SHA-256 is `8441bd47cf2464d747f9f236c84856bdaadea5d386c28b1816282f368c1d356c`. Update evidence is saved in `.tmp/new-pc/recovery-guide-58ab-update-independent.json`.

The corrected strict same-version installation repeat subsequently passed. Four original processes and streams joined normally, recorded profile/unrelated content and registry matches pass, and the sampled monitor stopped without failure. All 479 payload files were freshly rehashed after the repeat. The recovery guide now records this result while leaving loaded workflows and cold recovery pending; its current SHA-256 is `c81e1abafe43a902d6771492f00460a9afa175c0062b2b35fe192372f69dc062`. The preceding guide is preserved as `RECOVERY-before-strict-repeat-update-20261006.md`. Evidence: `.tmp/new-pc/recovery-guide-strict-repeat-update-independent.json`.

## October 6 startup configuration check

A fresh read-only check finds Home Assistant VM `c3b9e0c9-1f0f-4a36-ad47-98fd998bdd38` running with 2,048 MiB, two CPUs, EFI and the bridged Intel Wi-Fi adapter. AC automatic sleep and hibernate timeouts are both zero. The enabled logon startup task uses a 45-second delay, StartWhenAvailable, IgnoreNew and a three-minute execution limit; its last run on October 4 returned 0. This verifies current configuration and running state only. It does not prove a new boot, sleep/resume behavior, prevention of earlier guest clock stalls or recovery of the current extension. No settings, VM state or services were changed. Evidence: `.tmp/new-pc/pc-startup-readonly-20261006-current.json`.

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

## October 6 clock-stall recurrence during Sleep activation

Home Assistant initially failed hostname resolution, and direct connections to its previously observed address `192.168.100.160` timed out on ports 80, 8123 and 4357. VirtualBox still reported the Home Assistant VM running, with its state unchanged since October 5. The current VM log tail contained repeated `TM: Giving up catch-up attempt` entries at approximately 60 seconds of lag. These observations show a fresh availability failure alongside clock catch-up failures; they do not establish the underlying cause.

A single `VBoxManage controlvm "Home Assistant" pause` followed by `resume` completed successfully. No reset, power-off or reboot was issued. Focused mDNS discovery subsequently returned `192.168.100.160`, and HTTP port 80 returned 200. Port 8123 still did not answer during that probe. The authenticated Home Assistant browser then opened the script editor normally through `homeassistant.local`.

The saved manual Sleep script already turned the ceiling off first and excluded it from the repeated fade. The user-requested activation was performed once using **Run script**. The refreshed bedroom dashboard showed Sleep mode On, Ceiling Off, the other three bulbs at 5–7%, and PC RGB at 5%. This proves the immediate requested states, not completion of the entire 90-minute fade. Leave this run undisturbed during further readiness checks.

The temporary recovery does not close the PC reliability requirement. A controlled boot and a sustained clock/availability observation remain pending. Preserve the recurrence when evaluating any proposed timer or virtualization fix; the earlier successful startup configuration checks were insufficient to prove it resolved.

## Hypervisor execution-path investigation

The current VM is VirtualBox 7.2.20 with two CPUs, 2,048 MiB, UTC RTC, HPET off, default paravirtualization and effective KVM guest interface. Its startup log records `HM: HMR3Init: Attempting fall back to NEM: VT-x is not available` and `WHvCapabilityCodeHypervisorPresent is TRUE`. A fresh Windows `Win32_ComputerSystem.HypervisorPresent` query also returns true. The KVM guest interface does not mean the host is using native VT-x; the NEM log identifies the host execution path.

The log records GuestHeartBeat alive immediately after the pause/resume, followed by three more approximately 60-second catch-up failures. The recovery restored availability temporarily but did not eliminate clock lag.

Oracle's [VirtualBox 7.2 user guide](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/EN-VBOX-7-2-USER.pdf), section “Using Hyper-V with Oracle VirtualBox,” documents that VirtualBox can use Hyper-V as its host engine and may experience significant performance degradation. An [open report in the official VirtualBox repository](https://github.com/VirtualBox/virtualbox/issues/837) describes multi-minute NEM/WHPX stalls in 7.2.16 and an A/B comparison with native VT-x. That report concerns a different version and guest; it is a hypothesis lead, not proof of the cause on this machine.

Next controlled validation should preserve a current Home Assistant backup and the VM configuration, collect timestamped HTTP availability and clock-lag observations over a sustained interval, and compare an approved alternative execution path during a maintenance window. Home Assistant provides an official [Hyper-V installation path](https://www.home-assistant.io/installation/windows/), which is an option to assess if this Windows host must retain its hypervisor; migration and restore have not been tested here. Retain the existing controller identity and avoid simultaneously running a copied Matter controller on the household network. Check boot startup and the next scheduled routine before crediting recovery. No hypervisor, Windows security protection, VM timer setting or resource allocation was changed during this investigation.

## Recovery guide formatting correction

The October 6 guide formatting pass removes redundant blank lines, including gaps inside the PowerShell command block. All ordered nonblank lines remain identical. The exact prior guide is preserved at `D:/RayaBackups/Independent-20261005/RECOVERY-before-format-20261006.md` (12,593 bytes; SHA-256 `5393c9db54497f2b45519a8ab42bb90014732c9d6d4c3d77db26c067d4a1fab1`). The current guide is 12,356 bytes with SHA-256 `4d407aa97984b2a4650a889d62c61c845d7ccbd857e1d26a1dd512dc05d1cd29`. Evidence is saved in `.tmp/new-pc/recovery-guide-format-independent-20261006.json`. This changes presentation only; no restore, reboot, credentials or service action was performed.

## October 6 curation recovery supplement

`D:/RayaBackups/Independent-20261006-curation/verification.json` records six stable source/copy matches totaling 89,318 bytes: the updated Raya preferences, their dated October 6 source note, the health review and dashboard screenshot, the current checklist and recovery guide. This supplements the older curated snapshot; it does not replace it. The prior preferences are also preserved at `D:/Raya/SecondBrain/System/Versions/maintenance-20261006/Preferences/Raya.md`. Automatic capture and index rebuilding were not enabled. These are same-PC copies of selected files, not a whole-vault snapshot, software installer, off-PC backup, Home Assistant restore or semantic retrieval test.

## Audited replacement candidate retained outside temporary storage

The exact `4bfa78703d` candidate and its three independent archive/bin, native-debug/recipe and full expected-inventory proofs are saved in `D:/RayaBackups/ValidatedCandidates/4bfa78703d-1791266650994`. The VSIX is 190,493,982 bytes with SHA-256 `95e5fd981781e148eb6d9a2ba6b6ad605c2647923b1baf3223cf9d1c4851650f`. Source and copy were independently rehashed and matched. This is a same-PC recovery copy; it does not change the active rollback vault or demonstrate installation, rollback or an off-PC backup.

The original copy attempt exited 1 after writing and flushing the archive because it required cross-interface ctime equality. Python's path stat and held-handle stat reported different ctime values on Windows. Revalidation retained every field within each interface, required stable path and handle fields, and matched device/inode/size/mtime/link count across interfaces. Both actual ctime values and the earlier failures are preserved in `verification.json` and `.tmp/new-pc/4bfa-candidate-recovery-copy-independent.json`; the original failed attempt is not credited as passing.

## Fresh rollback backup before the 4bfa upgrade

Independently rehashed all eight retained VSIX archives and the exact saved package index in `D:/RayaBackups/PackageVault-20261006-before-4bfa-exact`. The nine files total 1,523,607,698 bytes. Each matches its recorded source digest and size, and the index lists exactly those eight archive digests. The backup verification file is 14,362 bytes with SHA-256 `48c6a819d03df0074ee89a73e27622d1d01a434e7068f273894ad57040e67b94`. The producer's job and terminal logs also match their recorded hashes; its original process and stream joins are owner-recorded, not recreated by this review.

Evidence is saved in `.tmp/new-pc/4bfa-eight-vault-backup-independent.json`. The initial review stopped at the same Windows cross-interface ctime mismatch before archive hashing. The qualified retry verifies all fields within each interface, common identity fields across interfaces, and records both ctimes. The failed attempt is not credited. This verifies the retained same-PC backup only; no live vault change, package activation, rollback boot or off-PC recovery was performed.

## Mystic Light startup ownership observation

The October 6 read-only task check reports `Raya Mystic Light Bridge` Ready with last result `267014` (hex `0x41306`) from October 4. The expected bridge is nevertheless listening on port 6742: PID 8588 is the Python interpreter child of the virtual-environment launcher PID 19724, both created October 4 at 11:24:32. The launcher's recorded parent PID 16908 is absent. This separates current listener availability from startup-task ownership; a Ready task and a live descendant do not prove reliable supervised recovery.

The saved `start.ps1` rejects an occupied port and then runs Python through a logging pipeline. During maintenance, verify that the scheduled task owns the full bridge lifetime, stopping the task retires its descendants, and a failed bridge is recovered once without duplicate hardware owners. Do not restart the current bridge during the active Sleep fade. No task, process, RGB value or network setting was changed in this review. The Home Assistant startup task still records a successful October 4 logon run; its script exits once the VM is running and does not test guest HTTP health or clock stalls.

## Recovery guide and checklist after the 4bfa installation

Updated the external guide and checklist to name the independently verified physical 4bfa installation, preserve the previous 58ab evidence as history, and separate installed Sleep adapter code from its still-pending saved-settings migration. The guide identifies the retained 4bfa candidate and exact pre-upgrade backup without claiming a new active vault entry or successful rollback. Workflow and boot requirements stay pending.

Exact prior bytes are retained in `D:/RayaBackups/Independent-20261006-curation/TODO-before-4bfa-installed-update.md` and `RECOVERY-before-4bfa-installed-update.md`. Current checklist: 10,950 bytes, SHA-256 `67999b55f5bf826cfc7ee4ea1cd6fa71c4fd607b8766ee4a0372369e5c169655`. Current recovery guide: 13,423 bytes, SHA-256 `0ad0077a7c40f805d0fc3bce34f5b113bd2cd8520db79017a9da08b1f674d075`. Evidence: `.tmp/new-pc/4bfa-recovery-checklist-update-independent.json`. This maintenance changes documentation only.

## Activated 4bfa rollback material and dependency coverage

The actual live vault now matches the producer's eight-entry index with 4bfa active. All eight archives independently match their recorded bytes and SHA-256 digests; seven prior rows are unchanged. The removed oldest inactive archive, digest `e282b269d7bfde56bee29ea0ee5d6c03dda95c60be1190c7359a0652b659b467`, independently matches its external pre-4bfa backup. The active embedded CLI matches the installed candidate's 300,046,336 bytes and `b855e0afb1521c20cd8901e2e35b4fe8d40971d2820c32bae77e94e79b1b96c8` digest. Evidence: `.tmp/new-pc/4bfa-bounded-vault-post-independent.json`. No rollback execution is credited. The updated guide is 14,036 bytes, SHA-256 `2bc9392542d9ebb5354aec79d6bd9076aebcbb70589ecab12035546aebd460b2`; its prior bytes are preserved in `Independent-20261006-curation/RECOVERY-before-4bfa-vault-activation.md`.

An independent read-only comparison verifies all 31,427 files listed in the primary dependency snapshot against the current `PrimarySnapshot/Lib/site-packages`, with zero missing or changed files. These files total 2,049,043,063 uncompressed bytes. The retained `D:/Raya/Services/Packaging/Snapshots/primary-1790987153926.zip` independently matches 589,263,497 bytes and SHA-256 `f3e291d4b94ee17d2c98502b1b51517e0bcab536386ca77c91c96640492794a2`; its manifest matches `6981adb7946d6198d2dde505f6a4c4536c20dc62f43dabc9caafd5bee0770da4`. Evidence: `.tmp/new-pc/primary-snapshot-current-dependency-coverage-independent.json`. The original read-only comparison session completed at exit 0 in about 190 seconds, without package imports, inference or service control.

This verifies the saved dependency subset against today's environment, not additional/excluded files, entry-point regeneration, base-Python reconstruction, model weights or a new restore. The existing `restore-dependencies.py` refuses an existing target and restores into its designated staged environment only; do not run it over a healthy installed environment. Preserve the manifest, archive, matching Python runtime and source snapshots together for later controlled reconstruction and service validation.

## Refreshed local service source snapshot and staged restore

The October 6 snapshot at `D:/RayaBackups/Local-Service-Sources-20261006-074817-6a132b58` preserves 121 selected source files (725,909 bytes): four previously covered files changed, and six recovery helpers/documents are newly covered. All source/copy hashes were checked and sources read again. The pinned manifest SHA-256 is `634076962dc68125ec2be13f6e7291ee57bf1b1ba655778d9d6f7c66194d19a9`.

An isolated restore at `D:/RayaBackups/RecoveryTests/Local-Services-Staged-88cf2c0946fa426baae6a2036a066325` matches all saved hashes and exact file/directory inventories. The external recovery guide now links it and retains its prior bytes in the snapshot. Evidence is `.tmp/new-pc/local-service-source-refresh-independent.json` and `.tmp/new-pc/local-service-source-staging-independent.json`. No saved script was executed; installed services, ownership, credentials, models, Home Assistant and lights were untouched. This does not establish full environment reconstruction or installed cold recovery.

The initial documentation append failed because Python selected the Windows legacy text encoding. The backup, staged restore and external guide had already completed; their hashes were revalidated before writing this document explicitly as UTF-8. The earlier failure remains preserved and does not represent a failed source restore.

## Matching base Python runtime backup

Saved the complete pinned base runtime at `D:/RayaBackups/Python-Runtime-3.12.14-20261006-075139-aa8f0441`: 2,294 files and 49,318,662 bytes. Every current source and copy matches the original receipt (SHA-256 `c2108fe3033e045996c45824de7eed7d8c8a698725384e9327c4309f0d39d5ff`), with all sources rechecked after copying and the exact copied file inventory verified. The external recovery guide links it and preserves its prior bytes. Evidence: `.tmp/new-pc/python-runtime-backup-independent.json`. No backup executable was run, environment reconstructed, model imported or service changed; cold runtime/service recovery is still pending.

## Restored base runtime execution and empty environment

The saved Python copy executed successfully in isolation, and a fresh empty venv loaded its restored base with an independent prefix. SQLite, asyncio, SSL context, in-memory WAV serialization and Windows native loading passed; all checked module origins are under the restored base. Both original processes exited 0 and their streams joined without force. Captured outputs and verification are at `D:/RayaBackups/RecoveryTests/Python-Runtime-d824b262df3940a6bf954dc7a8306e49`; independent evidence is `.tmp/new-pc/python-runtime-staged-execution-independent.json`.

The recovery guide preserves its prior bytes and links this test. This advances base-runtime recovery only. Third-party dependency restoration, model inference, service ownership, credentials and installed cold recovery remain unverified. No active service, installed environment, VM or light was changed, and no audio was played.
