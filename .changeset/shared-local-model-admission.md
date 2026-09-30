---
"@kilocode/cli": minor
"raya": patch
---

Let chats and workers share bounded model capacity when a provider is marked as a local model server.

Keep helper work on the selected local model instead of substituting a global cloud model.

Support keyless compatible local servers for native DeepSeek tool calls while preserving cloud credential checks.

Stop disconnected helpers before queued inference starts, and settle cancelled streaming responses correctly.
