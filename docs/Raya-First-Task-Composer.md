# First-task composer

This PR-01 / OVR-07 slice keeps one task entry point: the existing composer. Welcome asks for the desired result and relevant material, while recent work remains available. Work-style onboarding still requires an explicit choice through its existing permission workflow.

The composer shows the selected mode and **preferred model/provider** beside Configure. Auto can route work through other configured models; the summary is not an execution receipt. Expanding Configure exposes the existing real mode, model, reasoning and reset controls. The model picker retains pricing, provider and availability information. Attachments, access/sandbox controls and Send/Stop remain directly available.

The disclosure does not submit work, create a goal, change permissions or choose a company default. It does not add a new selection or draft store. Existing scoped draft, attachment, send, queued-steering and IME handling remain the submission path. Explicit goal-start reliability is a separate host concern.

Picker shortcuts reveal their owning disclosure before opening the existing picker. Selectors remain mounted while collapsed. Scoped focus return prevents another prompt from receiving focus after selection. Opening a newer picker invalidates pending restoration callbacks; an already focused popover also retains ownership when an older callback arrives late. Escape closes a picker first, then the disclosure when its own controls have focus.

## Validation

`bunx playwright test -c playwright.composer.config.ts` renders production WelcomeEmptyState and PromptInput, with the real configuration selectors, in Chromium. Fixture providers supply deterministic connection/catalog/session data and capture the session-send boundary; this is not a live provider invocation or extension-host integration test.

Cases cover 320px and 760px layouts in light, dark and high-contrast classes with forced colors; keyboard disclosure, actual mode selection, scoped model shortcuts, draft retention through connection/session changes, file attachment, explicit goal-send failure restoring both text and ordinary data-URL attachments without automatic retry, IME Enter exclusion, submitted selection identity, unavailable-model disclosure and accessibility checks. All six Chromium cases passed. Narrow expanded, wide collapsed and forced-color screenshots were inspected for wrapping, focus indication and horizontal overflow. Axe checks the configured light/dark/high-contrast palettes; forced system colors are exercised for interactions and captured separately because Axe mixes authored foreground colors with forced backgrounds. Existing logo and action-icon contrast under forced colors remains a separate visual gap. The focused prompt regression batch passed 163 tests / 353 assertions across seven files.

Company-recommended configuration, moderated first-success testing, setup-abandonment/time-to-first-success measurement, and migration of the remaining OVR-07 surfaces remain outstanding. No first-success usability result is inferred from these component tests.
