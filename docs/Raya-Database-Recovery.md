# Raya database upgrade recovery

Raya captures a recovery snapshot before the known historical migrations that discard session projections, workspace state, or credentials. Snapshot rows and the migration commit in the same SQLite transaction. If capture fails, the destructive migration does not run. If the migration fails, the transaction rolls back both changes and can be retried.

Snapshots are stored in the same database in `kilo_migration_backup` and `kilo_migration_backup_statement`. They are not an independent backup against disk loss. They retain private data, including credentials if present in the original database, and increase database size. They are never automatically expired. Take ordinary offline backups as part of deployment and retain the application version used before upgrading.

New databases start on the current schema without historical resets or recovery snapshots. Completed migrations are not replayed. Data deleted by an older version before this safeguard was installed cannot be reconstructed by this feature.

## List and export

Use the source CLI when testing this checkout, or the installed CLI after this change is released:

```text
kilo db backups
kilo db backups 20260622170816_reset_v2_session_state --output recovery.sql
```

The export refuses to overwrite an existing file. It contains the original schema, rows, indexes, triggers, views, sequence counters and migration journal. Internal recovery tables are excluded to avoid recursively copying earlier snapshots. Exported files are created with owner-only permissions where the operating system honors POSIX modes; use a private directory and appropriate Windows access controls.

## Recover into a separate database

1. Stop every Raya/Kilo process using the affected database before an upgrade or recovery. Keep the original database and its WAL files intact until all connections are closed; do not copy or replace only a live main database file.
2. Export the desired snapshot. Select the earliest relevant snapshot if multiple schema resets occurred during one upgrade.
3. Choose a new, nonexistent recovery database path. Never apply recovery SQL over a current database. With the SQLite CLI, use `sqlite3 -bail recovered.db` and then `.read recovery.sql`. `-bail` prevents continuing after a restore error.
4. Confirm `PRAGMA integrity_check;` returns `ok` and `PRAGMA foreign_key_check;` returns no rows. Inspect the recovered history, workspace associations and credentials needed for your recovery.
5. Open the recovered database only with the matching older application version and an explicit `KILO_DB` path, in a controlled recovery environment. Opening it with the current version will attempt the historical migrations again. Prefer exporting the needed historical content rather than downgrading the production database in place.
6. Keep the current database available until recovery is verified. This command does not install an older build, switch your active database, or merge old projections into the current runtime.

The safeguard preserves recoverability, not automatic semantic conversion of incompatible historical event formats. Release promotion still requires validating actual deployed database versions and the matching older recovery application. Do not claim historical chats remain directly resumable in the new runtime merely because their recovery snapshot exists.

## Explicit released upgrade policy

Raya's runtime policy is defined in `packages/core/src/kilocode/migration-policy.ts`. The migration journal decides whether a transition is pending; `session.version` is not a database-generation marker because one database can contain sessions created by several Raya versions. Every policy row requires an atomic recovery snapshot before its migration may run.

| First release | Nearest prior release tag | Storage lineage | Policy-covered destructive migrations | Rollout decision |
|---|---|---|---|---|
| `7.0.48` | `7.0.47` | SQLite upgrade | `20260303231226_add_workspace_fields` | Capture the complete database before removing the legacy workspace configuration. A populated historical workspace that SQLite cannot upgrade remains unchanged. |
| `7.2.4` | `7.2.3` | SQLite upgrade | `20260309230000_move_org_to_state` | Capture the complete account and state schema before moving the organization selection. |
| `7.3.2` | `7.3.1` | SQLite upgrade | `20260427172553_slow_nightmare` | Capture the complete session projection schema before replacing `session_entry`. |
| `7.4.8` | `7.4.7` | SQLite upgrade | Permission removal, projection-order reset and event-sourced input reset | Capture before each pending transition. The earliest snapshot is the authoritative pre-reset recovery point. |
| `7.4.16` | `7.4.15` | SQLite upgrade | `20260611192811_lush_chimera` | Capture a complete recovery database before the pending transition; refuse it if capture fails. |
| `7.4.21` | `7.4.20` | SQLite upgrade | Context simplification, v2 session-state reset and input simplification | Capture the pre-transition database before each pending migration. The earliest snapshot is the authoritative pre-reset recovery point. Refuse the transition if any required capture fails. |

The approved behavior is **recoverable reset**, not silent preservation in the new schema. Canonical `message` and `part` history survives the `7.4.21` reset, while incompatible projections, context epochs, event rows and workspace associations are reset only after the complete prior database is retained. Recovery remains an explicit export into an empty database opened with a compatible pre-reset runtime. The nearest prior release tag records source lineage; it is not automatically a compatible SQL recovery runtime. Raya never treats a snapshot as proof that old projections are directly resumable in the current runtime.

The policy validator requires unique migration and policy identities and refuses startup if a policy names a migration absent from the registered graph. Release evidence runs the policy and recovery suites. Its six predecessor application-schema fixtures are generated from the retained tags below, followed only by the compatibility journal needed by the current migration runner; every file has a test-pinned SHA-256.

| Prior release | Source commit | Fixture SHA-256 |
|---|---|---|
| `v7.0.47` | `702c27a8d2c21103079a43fc1e1b1d91f25c96df` | `B843336078771BFCCE28B3167D8E921082C64D6E8A3AA8B0AFAC4BB9903B94E1` |
| `v7.2.3` | `10bb4d11eeb3d7b7e94751e0b53af7be3d253e1b` | `0CFF3CFE3AEA4B72B7B6CC3E6F0E6B22F82D5038996DF1EC04CA676CCFF5396E` |
| `v7.3.1` | `64c60812ae730a30db1fa2226d9e446f7f10c127` | `FE09A909D1FD5171367848932290E4DA6EEFBB0E4A7E8EFB75B7CAAF4DE4302B` |
| `v7.4.7` | `afda9794582d164694d01a7c2179492295a08c3b` | `0AEB51D9B41CE13C0C7568831D41A08E31590EF93C4C078F992C5AC2FBF0BC2C` |
| `v7.4.15` | `13e425966261e159e915903df5a9e54792a0c657` | `E79163799CC044722C171FE43B0321FA5293E96F1C2FBFB904EB55F339183DAB` |
| `v7.4.20` | `62baedd258fbeb738929767258349f76d7f8a48d` | `7F5F6DAAF3DA3D301E9869B2EC26AB656340EDDF271560D3EDFEB1522DCD1C88` |

These paths prove the released schemas upgrade to current, each declared destructive boundary is captured, failed historical upgrades leave the predecessor untouched, and exported snapshots restore the relevant workspace, account, session projection, permission, credential, context, input and event evidence with clean integrity and foreign-key checks.

Databases that already ran a destructive migration before recovery snapshots shipped cannot be reconstructed from this safeguard. Release promotion must retain this limitation and must not promise recovered data that was never captured.
