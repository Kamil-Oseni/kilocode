# Raya preview evidence

The development [preview harness](../packages/kilo-vscode/webview-ui/preview/index.tsx) mixes production views and illustrative markup. Every frame now carries a visible evidence label and a `data-preview-kind` attribute so a screenshot or automated report can retain that distinction.

| Kind | Current fixtures | What the preview establishes |
|---|---|---|
| `production-view` | Goal banner states; usage history | Production view markup/styles under supplied sample data and simulated themes. It does not establish backend integration or successful host actions. |
| `illustrative` | Composer, slash bubble, review controls, top navigation, transcript, edit-review block, history, conversation | An illustration of the intended appearance. Failures or successes belong to the fixture, not to its production counterpart. |

The root class and labels are not an accessibility certification. Production interaction checks must render the relevant real component, drive its actual controls, and identify any simulated provider/host boundary. Preserve the label or record `data-preview-kind` whenever exporting a focused screenshot.

## Remaining UI-01 migration

Replace each illustrative fixture with its production component and typed deterministic provider data. The existing [PromptInput stories](../packages/kilo-vscode/webview-ui/src/stories/prompt-input.stories.tsx) and [history stories](../packages/kilo-vscode/webview-ui/src/stories/history.stories.tsx) already import production components, but their broad provider casts and stubbed actions need review before they become the acceptance harness. Do not copy those casts into a new supposed contract test.

For each migration, remove the duplicate markup, change the evidence label only after the real import is in use, and add interactions for keyboard/focus, narrow layouts, loading, failure and recovery. A production markup/style change must appear in that preview. Keep full host/backend and packaged checks separate from presentational assertions.

This increment fixes the immediate evidence-labeling gap. Composer/history/review migration and the full accessibility gates remain open under UI-01/UI-02.
