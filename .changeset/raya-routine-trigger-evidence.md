---
"@kilocode/cli": patch
"raya": patch
---

Show why a routine run started and preserve its scheduled time separately from startup time. Keep new manual runs from consuming future scheduled occurrences, and prevent clock changes or late history updates from rearming consumed calendar occurrences.
