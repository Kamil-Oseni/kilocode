# First Self-Redesign Goal

Paste the block below into Raya's chat in the second editor instance, with the
Designer agent selected and the raya folder open as the workspace. It starts with
`/goal`, so Raya arms a durable goal and begins in the same turn. It is deliberately
small: it stands up the reusable localhost preview harness and redesigns a single
presentational component, so you prove the whole edit, see, verify, iterate loop
before pointing it at anything larger.

Read `Raya-Self-Redesign-Guide.md` first for the one-time setup (branch, watch build,
Qwen provider check).

## Design direction (premium, applies to every goal below)

Raya's redesign should feel premium and distinctly Eden's, not like a default AI chat
panel. Type carries most of that. Use exactly two faces and no others: Instrument Serif
as the display face for large, expressive headings and hero or empty-state moments, and
Outfit as the body and UI face for everything else, including code and terminal output.
Both are free on Google Fonts; source their woff2 files from there and bundle them with
the webview so they render offline under the VS Code content-security policy rather than
relying on a network fetch. Expose them through the token layer as `--font-display`
(Instrument Serif) and `--font-body` (Outfit) with no fallback stack, so these two fonts
are the only type in the product and every surface consumes type through those tokens
rather than naming a family directly. Because there is no fallback, bundling the fonts so
they always load is what keeps text from dropping to a browser default.

Take navigation and interaction inspiration from ChatGPT where it is genuinely good, a
calm and uncluttered transcript, a focused composer, clear model and mode affordances,
and an unobtrusive history rail, and then build past it: warmer type, a more considered
spatial rhythm, real empty and loading states, and motion that feels physical. The bar
is a UI more refined than ChatGPT's, not a copy of it. All of this still answers to the
designer prompt's fundamentals, laws of UX, anti-slop rules, and physics-based motion;
the premium aesthetic sits on top of that discipline, never in place of it. Each goal
below restates the parts of this direction it needs so the pasted block stays
self-contained.

## The goal prompt

```
/goal Stand up a localhost visual-preview harness for Raya's SolidJS webview and use it to redesign one small presentational component to design tokens with Eden's premium typography. Work in the raya repo at C:\Users\User\Desktop\raya on the feature branch raya-self-redesign. This goal is complete only when every item below is true and verified against the current working tree; do not narrow the objective to an easier subset.

Design direction: the result should feel premium and distinctly Eden's, using Instrument Serif for display headings and Outfit for body and UI, and it may borrow interaction cues from ChatGPT where they are genuinely good while aiming to look more refined. Everything still answers to the designer prompt's fundamentals, laws of UX, anti-slop rules, and physics-based motion.

Deliverables and definition of done:

1. Preview harness. Add a dev-only preview entry under packages/kilo-vscode/webview-ui/preview/ and a "preview" script that runs esbuild in serve mode and renders isolated presentational components at a fixed localhost address (for example http://localhost:5199). Provide a mocked acquireVsCodeApi and mock props so components render with no running backend. Mark every fork addition with a // raya_change comment. Done when: `bun run preview` serves the page and it loads with no console errors.

2. Design tokens and type. Make the chosen component consume a small, named set of design tokens for color, spacing, radius, and type instead of magic values. If no token layer exists for the webview, add a minimal one and bind the component to it. As part of this, wire the typography into the token layer: source Instrument Serif (display) and Outfit (body) from Google Fonts, bundle their woff2 files with the webview so they load offline under the VS Code content-security policy, and expose them as --font-display and --font-body tokens with no fallback stack. Use only these two faces; do not add a monospace or any other family, and code uses --font-body. Done when: the component has no hardcoded hex or px that should be a token, every value traces to a token, and its type is set through --font-display or --font-body rather than a hardcoded family.

3. Component redesign. Choose one small, self-contained presentational component, preferring the goal status banner or the primary button, and redesign it against the design fundamentals. Render every state it implies: default, hover, focus, active, disabled, and any status variants it carries. Done when: all states render correctly in the preview in both light and dark VS Code themes.

4. Green smoke test. Run a browser smoke test named raya-selfredesign-v1 that navigates to the localhost preview, exercises each state, asserts each renders, and captures one screenshot per state. Done when: the smoke run is green with a screenshot per state, and you have read the screenshots and confirmed each state looks correct against the fundamentals.

5. Build integrity. Done when: `bun run compile` inside packages/kilo-vscode passes.

Constraints: stay on the feature branch; keep edits surgical and limited to the harness, the token layer, and the one component; match the existing SolidJS idioms and reactivity model in packages/kilo-vscode/webview-ui; do not touch unrelated files; mark fork additions with // raya_change. If the component you pick cannot render without the live backend, stop, say so, and choose a simpler presentational one.

Keep working across turns until the preview serves cleanly, the component is fully tokenized with every state verified in light and dark, the raya-selfredesign-v1 smoke run is green with per-state screenshots you have visually checked, and `bun run compile` passes. Verify each requirement against the actual files and command output before marking the goal complete.
```

## Why it is shaped this way

The definition of done is checkable rather than vibed. Each item names the evidence
that proves it: a serving localhost page, tokens with no stray literals, states
rendered in both themes, a green named smoke run with screenshots, and a passing
compile. Because the objective says the smoke test must pass, Raya's completion audit
requires a genuine green smoke result before it will close the goal, so the agent
cannot declare victory from a plausible-looking summary.

Once this loop works, later goals reuse the same harness and simply widen the target,
one component or one screen at a time.

## Next goals: scaling to a full overhaul

Run these in order, one at a time, after the first goal proves the loop. Review the
work at the checkpoints and commit between goals so each stage is reversible. Each
goal reuses and extends the same localhost preview harness, so the setup cost is paid
only once. The last goal is the real test of the designer prompt: it hands the agent
the whole webview and asks it to audit, repair, and unify everything to one system, in
both themes, gated by a comprehensive smoke run. Expect it to call out existing slop
for repair rather than preserve it; that is the designer prompt working as intended.

### Goal 2: a full panel (the composer region)

```
/goal Redesign Raya's chat composer region as one coherent, premium surface, reusing the localhost preview harness from the first goal. Work in C:\Users\User\Desktop\raya on the branch raya-self-redesign. Complete only when every item is true and verified.

Design direction: keep it premium and distinctly Eden's, setting type through the --font-display (Instrument Serif) and --font-body (Outfit) tokens from the first goal rather than any hardcoded family, and borrow composer cues from ChatGPT where they are genuinely good while aiming to look more refined. Everything answers to the designer prompt's fundamentals, laws of UX, anti-slop rules, and physics-based motion.

Scope: the prompt input (PromptInput.tsx), the goal banner (GoalBanner.tsx), and the selectable-options dock (QuestionDock.tsx) as a single composed region.

Definition of done:
1. Preview. Extend the harness to render the composer region with mock props, including an active, paused, and blocked goal banner and a pending question card. Done when: `bun run preview` shows the region with no console errors.
2. Tokens. Every color, space, radius, and type value in these components traces to a design token; no magic literals. Add semantic tokens where a real decision is named. Done when: no stray hex or px remains in the three components.
3. Audit and repair. Before restyling, audit the current region against the design fundamentals and the anti-slop rules in the designer prompt, name what breaks them, and fix it rather than preserving it. Done when: the region holds up against hierarchy, spacing, typography, contrast, the one-accent rule, and the no-slop checks.
4. States and themes. All interactive states (default, hover, focus, active, disabled) and the goal and question variants render correctly in light and dark. Done when: verified in the preview in both themes.
5. Motion. Any motion follows the physics-based, frequency-gated rules in the designer prompt. Done when: transitions are purposeful and none is gratuitous.
6. Green smoke. Run browser_smoke_test named raya-panel-v1 that navigates the preview, exercises every state and variant, asserts each renders, and screenshots each. Done when: the run is green with per-state screenshots you have visually confirmed.
7. Build. Done when: `bun run compile` passes.

Constraints: stay on the branch; match SolidJS idioms; keep edits scoped to the composer region, its tokens, and the harness; mark fork additions with // raya_change; commit when the region is done. Keep working across turns until all items are verified.
```

### Goal 3: a whole screen (the settings hub)

```
/goal Redesign Raya's settings hub as a full, premium screen, reusing and extending the localhost preview harness. Work in C:\Users\User\Desktop\raya on the branch raya-self-redesign. Complete only when every item is true and verified.

Design direction: keep it premium and distinctly Eden's, setting type through the --font-display (Instrument Serif) and --font-body (Outfit) tokens rather than any hardcoded family, and borrow settings and navigation cues from ChatGPT where they are genuinely good while aiming to look more refined. Everything answers to the designer prompt's fundamentals, laws of UX, anti-slop rules, and physics-based motion.

Scope: the settings hub screen and its primary sections (Providers, Agents & models, Speech, Goals & routing), including the section navigation and the tab surfaces (SpeechTab.tsx, GoalsRoutingTab.tsx, and their siblings).

Definition of done:
1. Preview. Extend the harness to render the settings hub with mock data for each section. Done when: `bun run preview` shows the screen and every section with no console errors.
2. Layout and hierarchy. The screen has a clear information hierarchy, a consistent spacing rhythm, aligned sections, and scannable navigation, judged against the design fundamentals. Done when: the layout reads cleanly at a glance and nothing is arbitrary.
3. Tokens. Every value across the screen traces to a token; introduce or extend semantic and component tokens as the system needs. Done when: no magic literals remain in the settings surfaces.
4. Audit and repair. Audit the existing settings UI against the fundamentals and anti-slop rules, call out what breaks them, and fix it. Done when: the screen passes the one-accent, one-grey-family, no-slop, and full-state-cycle checks.
5. States, themes, empty and error. Loading, empty, and error states are designed rather than defaulted, and everything renders in light and dark. Done when: verified in the preview.
6. Green smoke. Run browser_smoke_test named raya-screen-v1 that walks each section, exercises key controls, asserts render, and screenshots each section and state. Done when: green with screenshots you have visually confirmed.
7. Build. Done when: `bun run compile` passes.

Constraints: stay on the branch; match SolidJS idioms; scope to the settings hub, its tokens, and the harness; mark fork additions with // raya_change; commit when done. Keep working until all items are verified.
```

### Goal 4: the full overhaul

```
/goal Perform a full, premium design overhaul of Raya's webview UI to a single coherent design system, reusing and extending the localhost preview harness. Work in C:\Users\User\Desktop\raya on the branch raya-self-redesign. This is the largest goal; keep the full objective intact across turns and commit after each surface. Complete only when every item is true and verified.

Design direction: the finished UI should feel premium and distinctly Eden's and read as more refined than ChatGPT's, not a copy of it. Borrow navigation and interaction cues from ChatGPT where they are genuinely good (a calm transcript, a focused composer, clear model and mode affordances, an unobtrusive history rail) and build past them with warmer type, a more considered spatial rhythm, real empty and loading states, and physical motion. All of it answers to the designer prompt's fundamentals, laws of UX, anti-slop rules, and physics-based motion.

Definition of done:
1. Token foundation. Establish or complete a tiered token architecture for the webview: base tokens (palette, spacing, radii, type, durations, easing), semantic tokens (surface, text, border, status, accent), and component tokens minted only where a real decision is named. Light and dark are mode axes, not forks. Done when: the token layer exists, is documented in one place, and is the single source of truth.
2. Premium typography. Wire the type into the token layer and use it everywhere, with exactly two faces and no others: Instrument Serif as the display face for large, expressive headings and hero or empty-state moments, and Outfit for body, UI, code, and terminal output. Both are free on Google Fonts; source their woff2 files from there and bundle them with the webview so they render offline under the content-security policy, and expose them as --font-display and --font-body tokens with no fallback stack. Done when: every surface sets type through the font tokens, no surface hardcodes a font family or introduces a third font (including any monospace), and display and body faces are used deliberately rather than interchangeably.
3. Surface coverage. Restyle every primary surface to the system: the chat transcript (MessageList, VscodeSessionTurn, AssistantMessage), the composer region (PromptInput, GoalBanner, QuestionDock), the tool renderings (TaskToolExpanded and the tool overrides), and the settings hub. Done when: each primary surface consumes only tokens and shared components, with no stray literals.
4. Audit and repair. Across all surfaces, audit against the design fundamentals, the laws of UX, and the anti-slop rules in the designer prompt. Name every violation (arbitrary values, broken hierarchy, misalignment, failing contrast, duplicated or one-off components, slop styling) and repair it. Where a structural change would improve the system, propose it with reasoning rather than silently diverging. Done when: no primary surface violates the fundamentals or the anti-slop checks.
5. States, themes, motion. Every surface renders its full state cycle (default, hover, focus, active, disabled, empty, loading, error) in light and dark, and all motion follows the physics-based, frequency-gated rules. Done when: verified in the preview across surfaces and both themes.
6. Comprehensive smoke. Run browser_smoke_test named raya-overhaul-v1 that walks the main flows across every restyled surface, asserts render and key interactions, and screenshots each surface and state in both themes. Done when: the run is green with the full screenshot set, and you have read them and confirmed the overhaul holds up against the fundamentals and the premium bar.
7. Build. Done when: `bun run compile` passes and the extension still builds.

Constraints: stay on the branch and commit after each surface so progress is reversible; match SolidJS idioms and reactivity; keep the token layer the single source of truth; mark fork additions with // raya_change; do not break behavior while restyling. If a required decision is missing or a change needs your approval, set the goal blocked with a plain reason rather than guessing. Keep working across turns until every surface is on the system, the overhaul smoke run is green with verified screenshots, and the build passes.
```

A practical note on the overhaul: it is deliberately broad, and Raya's goal loop is built to carry it across many turns, but you will get the best result by letting it commit surface by surface and by reviewing its audit findings as they surface. If it proposes a structural change to the token model or a component API, that is the moment to weigh in before it proceeds.
