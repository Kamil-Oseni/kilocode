# Raya preview evidence

The development [preview harness](../packages/kilo-vscode/webview-ui/preview/index.tsx) mixes production views and illustrative markup. Every frame now carries a visible evidence label and a `data-preview-kind` attribute so a screenshot or automated report can retain that distinction.

| Kind | Current fixtures | What the preview establishes |
|---|---|---|
| `production-view` | Goal banner states; usage history; current and legacy memory receipts | Production view markup/styles under supplied sample data and simulated themes. It does not establish backend integration or successful host actions. |
| `illustrative` | Composer, slash bubble, review controls, top navigation, transcript, edit-review block, history, conversation | An illustration of the intended appearance. Failures or successes belong to the fixture, not to its production counterpart. |

The root class and labels are not an accessibility certification. Production interaction checks must render the relevant real component, drive its actual controls, and identify any simulated provider/host boundary. Preserve the label or record `data-preview-kind` whenever exporting a focused screenshot.

## Memory receipt browser checks

The `memory` and `memory-legacy` frames import the production `MemoryProvenance` component, production stylesheet and receipt decoder. Their deterministic metadata includes a long source filename, recorded scope/time and missing legacy fields. The preview supplies data only; the component's disclosure control is real.

Run `bunx playwright test --config playwright.preview.config.ts` from `packages/kilo-vscode/`. This dedicated configuration starts the local preview and checks both themes at 320px and 460px: keyboard expansion/collapse, retained focus, receipt labels, horizontal overflow and automated accessibility rules scoped to the receipt. Expanded screenshots are retained in test output for inspection. These checks do not establish host routing, backend receipt generation, screen-reader usability or complete WCAG conformance.

The eight cases passed on 9 September 2026. Visual inspection also caught adjacent title/count labels that the initial automated scan did not flag; the production style now separates them, uses the defined text-color token and displays a keyboard focus outline. The final suite checks label separation and the outline in addition to disclosure behavior.

## Remaining UI-01 migration

Replace each illustrative fixture with its production component and typed deterministic provider data. The existing [PromptInput stories](../packages/kilo-vscode/webview-ui/src/stories/prompt-input.stories.tsx) and [history stories](../packages/kilo-vscode/webview-ui/src/stories/history.stories.tsx) already import production components, but their broad provider casts and stubbed actions need review before they become the acceptance harness. Do not copy those casts into a new supposed contract test.

For each migration, remove the duplicate markup, change the evidence label only after the real import is in use, and add interactions for keyboard/focus, narrow layouts, loading, failure and recovery. A production markup/style change must appear in that preview. Keep full host/backend and packaged checks separate from presentational assertions.

This increment fixes the immediate evidence-labeling gap. Composer/history/review migration and the full accessibility gates remain open under UI-01/UI-02.
