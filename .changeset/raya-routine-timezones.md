---
"@kilocode/cli": patch
---

Evaluate calendar routines in their stored timezone, preserve a timezone on newly created schedules, and reject invalid timezone values before saving.

Reject unsupported recurrence syntax before saving, correct calendar step calculations, and support Sunday in weekday lists and ranges.

Find leap-day and other long-period calendar occurrences beyond one year, and reject impossible month/date combinations before saving.

Yield during long calendar searches so routine polling and previews can be interrupted without blocking the backend for the entire search.

Dispatch eligible timer routines through a bounded worker pool instead of waiting for every routine's calendar evaluation to finish.

Recheck timer eligibility before creating a session so completed or rescheduled routines do not start from an outdated poll selection.
