# Combined everyday source validation

Checked 2026-10-06 in the isolated everyday worktree. Merge `a8ef58f2bbd26857af99f5064b0c8065fc1d423d` combines everyday Memory work at `5ec2c3d451229ca425961b145ba7d5a5212b2a1a` with local diagnostic work at `59b5f045598d3efc81ef9e7c69b971b892aaa012`. The merge was conflict-free; the following checks test the combined source rather than infer compatibility from that fact.

Cloud workers remain stopped and all their work reservations are released. No new cloud work, automatic capture, scheduled consolidation, personal device trial or audible test was started.

| Check | Result |
|---|---|
| Core and CLI typechecks | Passed |
| Extension compile | Host and webview typechecks, lint and bundles passed |
| Native packaged helper | Nine tests passed; actual x64 protocol and current recipe validated |
| Memory recall | Six tests, 71 assertions passed; actual Python publication and reader traverse the TypeScript transport; stale policy/search seeds refused, fresh published bytes verified |
| Consolidation extension cohort | 21 tests, 138 assertions passed |
| Backend consolidation and listener shutdown | Four tests, 30 assertions passed |
| Chief, exact write, task recovery and refusal retirement | 19 tests, 909 assertions passed |
| Direct/process diagnostic attribution | Three tests, 24 assertions passed |
| Shared-source annotations | Passed against common base `8002368c915d3c0d7abdb69575d6e6ec057e4587` |
| Promise facade and Markdown table guards | Passed |

The current native helper recipe is `a2d7ec6c76b6211fadcb13607293fd16ed30dd0f97eaef761526e58b1c783925`. The source-matching helper was verified and staged into this worktree's ignored helper assets using the production staging path. The integration owner's assets were read only.

The extension compile reused this worktree's existing CLI binary. These results establish source compatibility and focused regressions, **not** a matching combined CLI package or installed acceptance. The integration owner must rebuild/package the combined source and preserve its backup, upgrade and native acceptance checks. No claim is made about actual model/GPU retirement, personal memory quality, live voice continuity or device behavior. Overall readiness is not advanced by this source-only checkpoint.

Private command logs are under `.tmp/memory-private/combined-*` in the everyday worktree. The first recall invocation skipped its Python-dependent cases; the qualified rerun supplied the pinned Python interpreter and exercised them. No skipped case is counted as proof.
