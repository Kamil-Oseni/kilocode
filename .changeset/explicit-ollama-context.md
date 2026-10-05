---
"@kilocode/cli": patch
---

Support an explicit Ollama connection mode that reports oversized prompts as context overflow instead of silently truncating them, while preserving selected output limits, local request scheduling, and cancellation across native and SDK connections.
