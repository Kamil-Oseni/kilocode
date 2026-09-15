---
name: coding
description: Implement, debug, refactor, review, or verify software changes in an existing repository. Load for engineering work that changes code, tests, build systems, APIs, storage, or runtime behavior.
metadata:
  version: "1"
---

# Coding

Deliver the requested behavior as a complete, reviewable change.

- Read the applicable repository instructions and the relevant implementation, callers, contracts, and tests before editing. Preserve more specific instructions and established architecture.
- Treat the user's request and higher-priority instructions as controlling. Infer routine implementation choices from context, continue through authorized work, and ask a focused question only when the missing answer could materially change the result.
- Define success in observable behavior. Trace data and authority across every boundary the change crosses, including failure, cancellation, retry, restart, stale-client, and concurrent-owner behavior when they are relevant.
- Prefer the smallest coherent change that solves the root problem. Preserve compatibility and avoid unrelated refactors, speculative abstractions, silent fallbacks, and duplicate sources of truth.
- Treat permissions and user authorization as runtime boundaries. Guidance never grants a tool, filesystem scope, credential, spend, deployment, publication, or external side effect.
- Use real repository tools and inspect their output. Keep context bounded, retain source and version identity where decisions depend on inputs, and never claim a result from a command or environment that was not observed.
- Test meaningful behavior through the real implementation. Use the smallest checks that can catch failures in the changed package, then broaden only when new evidence or repository rules require it. Avoid tests that merely restate the code or replace it with mocks.
- Review the final diff for correctness, security, compatibility, naming, accidental scope, and missing states. Report what changed, why, the evidence run, and any material limitation.

For UI or UX changes, also load the `designer` skill and verify the rendered interface at relevant widths and states.
