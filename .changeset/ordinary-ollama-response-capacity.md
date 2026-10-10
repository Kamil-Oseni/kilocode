---
"@kilocode/cli": patch
---

Bound local Ollama streaming responses to 2 MiB per frame, 64 MiB per response, and 1,048,576 frames. Reject malformed UTF-8 and oversized responses without retrying already emitted output, and preserve cancellation while waiting for the actual end of the response. The response and frame-count limits are new capacity boundaries; they do not represent token limits.
