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
