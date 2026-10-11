# Memory startup recovery

This patch targets a saved, genuinely closed service pair whose deterministic successor already exists with only the two plan files and empty Memory/Retrieval request namespaces. It does not adopt, remove, or overwrite that successor.

A reviewed selector uses format `raya.memory.closed-generation.fresh-start`, version `1`, and the existing `observation`, `setup`, and `managed` fields. The observation must be the exact saved closed receipt. Recovery validates the original pair and closure, preserves the reviewed notes root, release and interpreter/supervisor hashes, and admits only separate unused namespaces and different service ports. Pending request uncertainty, unfamiliar partial artifacts, changed files, current producers, unreadable selected interpreter identities, and occupied ports refuse admission. Existing archive publication retains the previous setup, credential reference, and partial snapshot; it does not claim historical settlement or replay a failed request.

Checks on this source:

- Focused closed-pair/partial-generation tests: 3 passed, 42 assertions, including actual original process exit and joined readers.
- Broader restart tests: 21 passed and one existing generated-fixture failure. The helper slice included unrelated `test()` calls in a standalone child; the exact slice was repaired. The failed test and final partial-generation tests then passed: 3 tests, 30 assertions. The final owner refusal includes an actual protected non-Python Windows process with unreadable metadata.
- Final extension/webview types, lint, bundling, forbidden-marker guard, and whitespace checks passed. Package formatting completed; 45 clean-before unrelated formatter changes were restored.
- Full `compile` stopped during CLI preparation because this worktree lacks `node_modules/@raya/ws/wrapper.mjs`. No usable CLI or installation resulted. The direct `build:check` passed; the build chat owns the coherent CLI/package.

Still required: prepare the exact fresh-start selector and unused service artifacts for the saved private profile; test full archive publication and stale-selection refusal for this new format; import the patch into the coherent build; verify installed recovery, search, and conversation integration. Current tests establish source behavior, not installed acceptance. No production credential, notes, partial generation, lights, or installed extension was modified.
