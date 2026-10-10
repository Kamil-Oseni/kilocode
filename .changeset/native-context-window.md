---
"@kilocode/cli": patch
---

Use the selected native model context for prompt, tool, recall and output budgets, including explicit windows for models with unknown context metadata. Select tool discovery when the native catalog exceeds envelope capacity. Check the transformed final local request before sending it, preserving fixed instructions and refusing requests that exceed the estimated budget.
