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
