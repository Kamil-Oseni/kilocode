---
"raya": patch
---

Isolate experimental voice transport so stopped native connections retain cleanup ownership until their process exits, and wait for connected audio and control channels before accepting the first action.
