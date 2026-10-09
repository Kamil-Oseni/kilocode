---
"raya": patch
---

Reuse the verified tokenizer within each Memory recall request to avoid repeated startup while checking note passages. Recover cancelled reads through an explicit audit and update closed Memory runtimes without replaying requests or changing saved notes.
