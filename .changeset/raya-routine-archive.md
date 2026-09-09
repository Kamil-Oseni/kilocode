---
"@kilocode/cli": patch
"@kilocode/sdk": patch
---

Preserve final routine definitions during removal and expose a read-only archive list alongside retained run history and original instructions.

Return archive definitions in pages of up to 50 entries, with cursor continuation and direct routine lookup.

Import legacy archives once into indexed database storage, retain the source file for recovery, and avoid rereading or rewriting the full archive on subsequent requests and removals.
