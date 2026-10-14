# Raya recovery quickstart

Updated October 14, 2026. Use this when recovery is needed. Home Assistant's VM is intentionally powered off at the latest read-only check; do not restart it or change lights without a new request. A deliberately stopped VM is not a fault to repair. Consult the October 14 checkpoint in [the current checklist](D:/Raya/TODO.md) for the installed version and acceptance scope; older dated readiness sections are historical.

## What is verified

Fresh read-only checks are saved in [Recovery-Verification-20261010.json](D:/RayaBackups/Recovery-Verification-20261010.json).

| Saved copy | Verification result | Limit |
|---|---|---|
| Home Assistant `full-backup-8753177b-20261003.tar` | Size and SHA-256 match receipt; outer file members readable | Metadata says partial despite the filename; no live restore |
| Home Assistant `automatic-29abd8c0-20261004.tar` | Size and SHA-256 match receipt; outer file members readable | No live restore |
| SecondBrain `SecondBrain-Sources-20261009-2596-grocery/Files` | All 143 manifest files match size and SHA-256 | Historical source snapshot, not a current index or complete service backup |
| SecondBrain `SecondBrain-Sources-20261009-f6327715/Files` | All 113 manifest files match size and SHA-256 | Older source snapshot |
| SecondBrain `SecondBrain-Sources-20261010-c079638f/Files` | October 11: all 156 manifest files, 552,573 bytes, independently match size and SHA-256 | Source and retained provenance only; excludes indexes, operation debt and binary media; no live restore |
| SecondBrain `SecondBrain-20261012-daa2c9e0624044b68644fbc4ab7042d9/Files` | All 168 files, 998,217 bytes, match size and SHA-256; source file set and bytes unchanged during copying | Complete closed-folder snapshot with retained operational evidence and indexes; restore notes selectively; local copy only |
| SecondBrain `SecondBrain-20261012-5a2862ff69ac44e6bff2040aa9c6529a/Files` | Post-curation: all 182 files, 1,103,179 bytes, match size and SHA-256; source unchanged during copying | Includes four-note reconciliation and its before/after journal; local copy only, no restore or replay |
| SecondBrain `SecondBrain-20261014-69f0b2c74f48491d856b16d268087dc2/SecondBrain` | Recorded verification: 192 files, 1,233,356 bytes; source unchanged during copying and all copied bytes match | Includes note history and derived index; local file snapshot, not live-service recovery or off-PC protection |
| `Independent-20261006-curation` | All six selected files match size and SHA-256 | Historical reference copies |

The later Home Assistant `sleep-ceiling-off-c1dce02b-20261006.tar` was inventoried and hashed in the report. Its checksum was not compared with a historical receipt, so it is not included in the receipt-match passes. Choose backups by their date and included components rather than their filenames. These checks did not restore anything, run models, export credentials or verify installed recall. All listed copies are on this PC; off-PC protection remains unverified.

## Home Assistant

1. If the current system works, save a fresh backup before replacing settings. Preserve the existing VM disk and select a maintenance time when changing lights will not disturb anyone.
2. On a working installation, open **Settings → System → Backups**, select the intended backup and components, then **Restore**. For a fresh Home Assistant installation, use **Upload backup** on its welcome screen. Have the original login details and the emergency kit available if decryption is required. Wait for restoration and restart before logging in. See the [official restore instructions](https://www.home-assistant.io/common-tasks/general/#restoring-a-backup).
3. Check that dashboards, Matter devices, scripts and schedules survived. Older copies may omit later modes and the ceiling-off Sleep change. Test lights only when requested and everyone affected is awake.

Backup archives and `D:/RayaBackups/HomeAssistant/Recovery-key.txt` are private recovery material. Keep the key separately from a shared guide. Do not start a second restored controller on the household network alongside the existing controller.

## SecondBrain notes

1. Preserve the current `D:/Raya/SecondBrain` folder and any pending capture records. Choose a dated snapshot that contains the note you need.
2. Copy the snapshot's note directory to a separate staging folder. Older snapshots use **Files** with `manifest.json`; the October 14 snapshot uses **SecondBrain** with `receipt.json`. Compare each relative path, byte count and SHA-256 against the corresponding member list before using the files.
3. Restore selected notes after comparing them with newer live notes. Preserve provenance and explain corrections. Avoid replacing the whole live folder with an older snapshot.
4. Use Raya's supported Memory recovery and indexing controls. A copied pending capture record does not authorize replay or settle an uncertain operation. Do not copy old indexes or ownership records over current ones.

The older source snapshots exclude credentials, binary media and derived indexes. The October 12 complete folder snapshots also retain operational evidence and indexes; those files preserve history and must not overwrite a current service's ownership, admission or pending-request state. The pre-curation manifest SHA-256 is `e38b472e56e1c3093b35ccdc4b22f6167207478667567ff19253dbb0e0d0b6d5`; the post-curation manifest is `449ea2dfe3193497ded07469b9840901167e768ed17062aeabdd4fec6194ea27`. Both fresh vaults have protected permissions for the current user, SYSTEM and administrators. File integrity does not prove that installed Raya can retrieve notes correctly. No live restore was performed.

The October 14 receipt SHA-256 is `766b2096b5c497fc984b3439cf741e858b8377e8d795d9e3be96c5a69bf897a3`. It predates the later pending manual-save proposal; preserve that proposal and its source from the current folder rather than treating this snapshot as its backup. The failed manual-save evidence and repair criteria are recorded in [the diagnosis](Raya-Memory-Manual-Save-Diagnosis.md). Administrative recovery preserves uncertain operation history without settling or replaying the original request.

## Raya extension and local services

1. Save current profile/settings and note the installed version before changing it. Close the affected Raya window normally and allow its owned jobs to finish or cancel through supported controls.
2. Use the supported extension install/rollback flow with a reviewed VSIX. Consult [current readiness](Raya-Current-Readiness.md) for the installed version. Do not replace package-vault registries or SecretStorage manually. The protected `D:/RayaBackups/Everyday-worker-repairs-20261012-owner-a1694488e9d24dc0a15ca7bb69fe4f75/rollback.vsix` restores the earlier `f3a3aa4df9` release, not the current package. Its saved profile copies and copy receipt are in the same folder. Preserve newer profile data before any rollback; package rollback alone is not a profile restore. Historical candidate checks do not qualify every everyday workflow.
3. Use the installed lifecycle owner to recover Speech, Memory and Retrieval. Inspect a busy or refused stop before retrying; do not kill every Python process. Confirm service health and a small real request after recovery.
4. If files or dependencies are missing, recover from reviewed package/model manifests and the corresponding environments. Historical source copies alone do not include model weights, Python environments, access tokens or the complete installer. Re-enter credentials through the supported masked setup flow when required.

Detailed historical material is retained in [the October 6 recovery guide](D:/RayaBackups/Independent-20261006-curation/RECOVERY.md). Its version and active-package statements are historical, not instructions to downgrade to that version. Current installed acceptance is tracked in [Raya-Current-Readiness.md](./Raya-Current-Readiness.md).

## Remaining recovery work

- Off-PC destination: Kamil chose to decide later. Keep the local backups; do not upload or copy the emergency kit elsewhere until a destination is chosen.
- Perform an isolated Home Assistant restore rehearsal during an agreed maintenance window.
- Qualify installed extension rollback, local-service recovery and Memory recall on the release candidate. The integrity checks above do not replace those workflow tests.
