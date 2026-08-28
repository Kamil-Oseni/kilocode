# First Self-Redesign Goal

Paste the block below into Raya's chat in the second editor instance, with the
Designer agent selected and the raya folder open as the workspace. It starts with
`/goal`, so Raya arms a durable goal and begins in the same turn. It is deliberately
small: it stands up the reusable localhost preview harness and redesigns a single
presentational component, so you prove the whole edit, see, verify, iterate loop
before pointing it at anything larger.

Read `Raya-Self-Redesign-Guide.md` first for the one-time setup (branch, watch build,
Qwen provider check).

## The goal prompt

```
/goal Stand up a localhost visual-preview harness for Raya's SolidJS webview and use it to redesign one small presentational component to design tokens. Work in the raya repo at C:\Users\User\Desktop\raya on the feature branch raya-self-redesign. This goal is complete only when every item below is true and verified against the current working tree; do not narrow the objective to an easier subset.

Deliverables and definition of done:

1. Preview harness. Add a dev-only preview entry under packages/kilo-vscode/webview-ui/preview/ and a "preview" script that runs esbuild in serve mode and renders isolated presentational components at a fixed localhost address (for example http://localhost:5199). Provide a mocked acquireVsCodeApi and mock props so components render with no running backend. Mark every fork addition with a // raya_change comment. Done when: `bun run preview` serves the page and it loads with no console errors.

2. Design tokens. Make the chosen component consume a small, named set of design tokens for color, spacing, radius, and type instead of magic values. If no token layer exists for the webview, add a minimal one and bind the component to it. Done when: the component has no hardcoded hex or px that should be a token, and every value traces to a token.

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
