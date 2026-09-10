# Action semantics: first UI-03 slice

This slice standardizes destructive confirmation buttons in four extension surfaces. It preserves the existing shared primitives and each host's default appearance. It does not establish complete cross-client loading, status, or recovery semantics.

## Component contract

`@kilocode/kilo-ui/button` continues to export the upstream button module. Its Kilo-owned `Button` adapter adds `variant="destructive"` without inserting a DOM wrapper. Existing properties, children, refs, events, sizes and native disabled behavior pass through to the upstream component using reactive props.

| Meaning | Kilo UI API | Rendered behavior | Web UI mapping |
|---|---|---|---|
| Omitted variant | No `variant` | Existing secondary default | Existing primary default; intentionally unchanged |
| Primary action | `variant="primary"` | Existing primary button | `variant="primary"` |
| Secondary action | `variant="secondary"` | Existing secondary button | `variant="secondary"` |
| Low-emphasis action | `variant="ghost"` | Existing ghost button | `variant="ghost"` |
| Destructive action | `variant="destructive"` | Upstream secondary behavior with `data-intent="destructive"` | Existing `variant="destructive"` |
| Disabled action | `disabled` | Native upstream disabled behavior | Native host component behavior |

The adapter deliberately preserves the upstream `data-variant="secondary"` implementation for destructive buttons. Kilo styles select `data-intent="destructive"`; consumers should use the public variant rather than recreate class-based overrides. Switching to another variant removes destructive intent reactively.

Kilo UI retains `small`, `normal` and `large` sizes and the `normal` default. Web UI retains its broader size vocabulary and its `default` mapping. Changing those defaults across unrelated screens is outside this increment.

## Host appearance

Destructive buttons use the host's critical surface and border tokens with ordinary strong text. The VS Code bridge currently maps both critical strong surface and critical text to an error color, so pairing those two tokens would not create readable text. Existing focus and disabled behavior remain in place. Forced-color mode uses system button, highlight and disabled colors.

This replaces three local appearance rules: `dialog-destructive-btn`, `danger-btn` and `am-confirm-delete`. Dialog spacing, radius, labels, surrounding content and callback ownership remain with the extension surfaces. Confirmation action rows wrap, and their buttons allow multiline labels within the available width; the real 320-pixel long-label fixture exposed overflow before this correction.

## Migrated confirmations

| Consumer | Destructive action | Initial focus | Preserved behavior |
|---|---|---|---|
| `history/SessionList.tsx` | Delete session | Cancel | Session callback, dialog closure and originating-row focus restoration |
| `routines/RoutinesView.tsx` | Remove selected routines | Keep | Existing routine message and selected-row handling |
| `marketplace/RemoveDialog.tsx` | Remove item | Cancel | Caller-owned confirm and close callbacks |
| `agent-manager/AgentManagerApp.tsx` | Remove stale worktree entry | Cancel | Existing removal callback and explicit Ctrl/Cmd+Enter shortcut |

Initial focus is assigned to the non-destructive action through the existing Dialog autofocus mechanism. This does not turn cancellation into work cancellation or change the meaning of the destructive operation. A click still invokes the existing caller; the button adapter does not claim that an asynchronous deletion or removal has completed.

The first real browser run exposed an existing focus gap: imperative dialogs have no Kobalte Trigger, so Escape closed the dialog without returning focus to its opener. A minimal optional `onCloseAutoFocus` hook is forwarded by the shared Dialog; upstream consumers retain their existing default behavior. The Kilo Dialog adapter captures the opener and restores it only when that dialog is the latest active dialog, the opener remains connected and enabled, and focus has not already moved elsewhere. Caller-provided close-focus handlers can prevent this behavior. Solid cleanup removes each ownership token even if rendering never reaches the content's focus effect; a generation check fences delayed close callbacks after a newer dialog opens. This keeps replaced dialogs from stealing focus from newer dialogs and preserves caller-owned restoration.

An abrupt-provider-removal browser case also reproduced an orphaned dialog: the provider created detached Solid roots but did not dispose them during its own cleanup. One marked shared cleanup line now disposes the provider's active dialog roots. It does not replay confirm or close callbacks. Existing animation and close behavior remain unchanged.

## Verification and remaining work

The paired component fixture uses the real Button, Dialog provider, marketplace removal dialog and production styles. Its acceptance covers reactive variant/disabled forwarding, normal button semantics, focused Enter/Space activation, initial Cancel focus, Escape restoration, light/dark/forced-color rendering and 320/460-pixel layouts. The initial six-case run failed at Escape restoration after the native button and initial-focus assertions passed. That failure is retained; the corrected run is recorded after the coordinated validation batch.

The final checkpoint browser invocation passed all nine cases in 1.5 minutes with native exit 0. It supersedes the earlier passing evidence split across scoped runs:

| Check | Actual result |
|---|---|
| Six light/dark/forced-color cases at 320/460 pixels | Passed with production styles and root-scoped host theme variables; no Axe violations or normal-label overflow. Screenshots visually inspected for light 320/460, dark 320 and forced-color 320. |
| Nested, replaced and detached dialog openers | Passed after the fixture waited for the public active-dialog identity to change. Portal removal alone precedes the provider's existing 100 ms close transition and was not a valid readiness condition. |
| Long localized labels at 320 pixels | Passed after action wrapping; screenshot inspected. The earlier run placed a button partly outside the viewport. |
| Caller-owned focus and abrupt inner-provider removal | Passed with an existing outer dialog retained: the caller's `preventDefault` handler controls focus, the disposed inner dialog disappears, and closing the outer dialog restores its original opener. Final targeted process exited 0. |

Run the suite from `packages/kilo-vscode` with `bunx playwright test --config playwright.destructive-controls.config.ts`. Final evidence is retained in `.tmp/destructive-controls-checkpoint.log` and `.tmp/ui03-checkpoint-results`. Earlier scoped evidence remains in `.tmp/destructive-controls-browser.log`, `.tmp/destructive-controls-ownership.log`, `.tmp/destructive-controls-owner-final.log`, `.tmp/ui03-browser-matrix` and `.tmp/ui03-ownership-results`; failures and initial-click timeouts are preserved. Scoped formatting, extension ESLint, Kilo Dialog lint and the shared annotation guard passed. The coordinated checkpoint's CLI/extension types, full extension lint and Knip also passed.

The independent nested-provider setup revealed a separate limitation: opening a second provider's modal inside an already-modal outer provider does not reliably transfer initial autofocus. That setup uses visibility and a real click to exercise teardown; it does not claim to fix cross-provider autofocus. Initial Cancel focus and same-provider nested focus remain strict assertions in their own cases.

Agent-behaviour skill/mode/MCP removal dialogs, other confirmation layouts, application-wide pending/error presentation, other clients and manual assistive-technology acceptance remain outside this first slice. Their migration should reuse this explicit semantic role rather than changing global defaults.


Final consolidated checkpoint: the complete nine-case suite passed on frozen final source in 1.5 minutes with native exit 0 (.tmp/destructive-controls-checkpoint.log). Screenshots are retained under .tmp/ui03-checkpoint-results. This supersedes the earlier scoped acceptance runs without erasing their failure evidence.
