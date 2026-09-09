---
"raya": patch
---

Preserve the last saved canvas when an update fails and restore it after reopening the extension. Offer draft inspection and retry, require draft edits to be saved before retrying, and reject late acknowledgements from superseded renders.

Reject malformed saved canvas records before replacing artifact files during restoration.

Limit canvas cache history to 20 recent revisions while preserving the saved revision and active recovery candidates.

Offer draft inspection and retry for errors that occur after a canvas has rendered, and ignore duplicate or obsolete error messages.

Retain the previous saved revision and restore it when a later canvas fails after rendering.

Restore unchanged editable source/data during rollback, and preserve local edits with a warning when those files differ from the failed revision.

Preserve source/data edits made while a successful canvas update is compiling or rendering, and warn when the saved canvas differs from editable files.
