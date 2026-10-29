# Restored-profile recovery check — October 29, 2026

The existing full restored-profile case now completes naturally with every recovery assertion preserved. This is a test-harness timing correction, not a production recovery change or an installed startup-speed result.

## Cause and change

The original helper killed the entire source child after ten seconds. That interval included source imports, memory checks, database/runtime setup, HTTP history checks and shutdown. A mandatory Windows process-identity request independently permits fifteen seconds, so the aggregate test guard could expire first.

The unchanged current-source baseline reproduced the old failure: child exit 143 before its first post-import trace. No application exception or corruption assertion established a production defect.

The child budget is now thirty seconds, with an explicit expiry failure and a unique per-attempt timing record. The outer limit is 150 seconds (155 seconds for the enclosing test), covering four bounded restarts plus setup. Every original SQL, Goal, memory, held/reviewed transfer, no-replay, receipt, exit-code and PID-gone assertion remains.

## Observed result

Command, from `packages/opencode`:

```text
bun test ./test/kilocode/profile-bundle.test.ts --test-name-pattern 'real shipped SQL schema and persistent goal restore'
```

One selected test passed, six unrelated cases were filtered out. The test took 57.05 seconds; total command time was 58.87 seconds. All four child processes exited zero without their deadline firing:

| Fresh transfer | Mode | Full child elapsed |
|---|---|---|
| First destination | Held | 16.60 seconds |
| First destination | Reviewed | 5.80 seconds |
| Second destination | Held | 15.94 seconds |
| Second destination | Reviewed | 5.82 seconds |

The two held durations exceed the former ten-second aggregate guard. They are full source-process measurements, not isolated server startup timings.

## Evidence and limits

Source base: `7a5a909191`. Worktree: `raya-everyday-experience`.

- Original failure log: `.tmp/new-pc/profile-restart-baseline-20261029.log`.
- Passing full-case log: `.tmp/new-pc/profile-restart-budget-20261029.log`.
- Fresh fixture root: `C:/Users/kamil/AppData/Local/Temp/raya-profile-bundle-F7YrK9`; four `restart-*.timing.json` records identify the exact destination and mode.
- Scoped lint: zero warnings/errors. Full CLI type checking passed; its output is recorded in `.tmp/new-pc/profile-restart-types-20261029.log`.

No production code, model, everyday profile, Home Assistant or lighting was changed. Direct-child termination behavior is unchanged; no broader forced descendant-retirement guarantee is claimed. This result closes the previously failing source restore case only. It does not prove a Windows reboot, a loaded installed client, scheduled multi-period work, or the real multiworker workflow, and does not promote an overall readiness percentage.
