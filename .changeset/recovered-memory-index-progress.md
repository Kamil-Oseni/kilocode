---
"kilo-code": patch
---

Show progress and cancellation for recovered Memory indexing. Keep the original operation pending until its work and readers finish, refuse further work after cancellation or ten minutes of active processing, and prevent duplicate indexing commands from starting another operation.
