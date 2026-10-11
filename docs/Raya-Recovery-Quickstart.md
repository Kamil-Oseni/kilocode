# Raya recovery quickstart

Updated October 11, 2026. Use this when recovery is needed. Home Assistant is running and its dashboard returns HTTP 200. Temporary test shutdowns use ACPI and are followed immediately by restart; a deliberately stopped VM during a test is not a fault to repair.

## What is verified

Fresh read-only checks are saved in [Recovery-Verification-20261010.json](D:/RayaBackups/Recovery-Verification-20261010.json).

| Saved copy | Verification result | Limit |
|---|---|---|
| Home Assistant `full-backup-8753177b-20261003.tar` | Size and SHA-256 match receipt; outer file members readable | Metadata says partial despite the filename; no live restore |
| Home Assistant `automatic-29abd8c0-20261004.tar` | Size and SHA-256 match receipt; outer file members readable | No live restore |
| SecondBrain `SecondBrain-Sources-20261009-2596-grocery/Files` | All 143 manifest files match size and SHA-256 | Historical source snapshot, not a current index or complete service backup |
| SecondBrain `SecondBrain-Sources-20261009-f6327715/Files` | All 113 manifest files match size and SHA-256 | Older source snapshot |
| SecondBrain `SecondBrain-Sources-20261010-c079638f/Files` | October 11: all 156 manifest files, 552,573 bytes, independently match size and SHA-256 | Source and retained provenance only; excludes indexes, operation debt and binary media; no live restore |
| `Independent-20261006-curation` | All six selected files match size and SHA-256 | Historical reference copies |

The later Home Assistant `sleep-ceiling-off-c1dce02b-20261006.tar` was inventoried and hashed in the report. Its checksum was not compared with a historical receipt, so it is not included in the receipt-match passes. Choose backups by their date and included components rather than their filenames. These checks did not restore anything, run models, export credentials or verify installed recall. All listed copies are on this PC; off-PC protection remains unverified.

## Home Assistant

1. If the current system works, save a fresh backup before replacing settings. Preserve the existing VM disk and select a maintenance time when changing lights will not disturb anyone.
2. On a working installation, open **Settings → System → Backups**, select the intended backup and components, then **Restore**. For a fresh Home Assistant installation, use **Upload backup** on its welcome screen. Have the original login details and the emergency kit available if decryption is required. Wait for restoration and restart before logging in. See the [official restore instructions](https://www.home-assistant.io/common-tasks/general/#restoring-a-backup).
3. Check that dashboards, Matter devices, scripts and schedules survived. Older copies may omit later modes and the ceiling-off Sleep change. Test lights only when requested and everyone affected is awake.

Backup archives and `D:/RayaBackups/HomeAssistant/Recovery-key.txt` are private recovery material. Keep the key separately from a shared guide. Do not start a second restored controller on the household network alongside the existing controller.

## SecondBrain notes

1. Preserve the current `D:/Raya/SecondBrain` folder and any pending capture records. Choose a dated snapshot that contains the note you need.
2. Copy the snapshot's **Files** directory to a separate staging folder. Compare each relative path, byte count and SHA-256 with its `manifest.json` before using the files.
3. Restore selected notes after comparing them with newer live notes. Preserve provenance and explain corrections. Avoid replacing the whole live folder with an older snapshot.
4. Use Raya's supported Memory recovery and indexing controls. A copied pending capture record does not authorize replay or settle an uncertain operation. Do not copy old indexes or ownership records over current ones.

The source snapshots exclude credentials, binary media and derived indexes. Text-file integrity does not prove that installed Raya can retrieve them correctly.

## Raya extension and local services

1. Save current profile/settings and note the installed version before changing it. Close the affected Raya window normally and allow its owned jobs to finish or cancel through supported controls.
2. Use the supported extension install/rollback flow with a reviewed VSIX. Do not replace package-vault registries or SecretStorage manually. The private `fb6b69486e` test installation has passed draft and typed conversation checks. The qualified `05fe58e60f` Stop-diagnostic package awaits private upgrade verification. Consult current readiness before selecting a package; these checks do not qualify every everyday workflow.
3. Use the installed lifecycle owner to recover Speech, Memory and Retrieval. Inspect a busy or refused stop before retrying; do not kill every Python process. Confirm service health and a small real request after recovery.
4. If files or dependencies are missing, recover from reviewed package/model manifests and the corresponding environments. Historical source copies alone do not include model weights, Python environments, access tokens or the complete installer. Re-enter credentials through the supported masked setup flow when required.

Detailed historical material is retained in [the October 6 recovery guide](D:/RayaBackups/Independent-20261006-curation/RECOVERY.md). Its version and active-package statements are historical, not instructions to downgrade to that version. Current installed acceptance is tracked in [Raya-Current-Readiness.md](./Raya-Current-Readiness.md).

## Remaining recovery work

- Select an off-PC destination and copy the chosen backups and separately protected emergency kit.
- Perform an isolated Home Assistant restore rehearsal during an agreed maintenance window.
- Qualify installed extension rollback, local-service recovery and Memory recall on the release candidate. The integrity checks above do not replace those workflow tests.
