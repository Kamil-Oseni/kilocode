# Driving Raya to Redesign Its Own UI

This guide sets up a working loop where Raya redesigns its own interface. The
designer agent edits the webview code, sees the result in a real browser, verifies
it with a smoke test, and iterates, all under a single durable goal. You drive it
from a second editor instance so the work does not restart the very extension doing
the work, and you give the designer a localhost preview so it can actually see what
it is building.

The companion file `Raya-Self-Redesign-Goal.md` holds the exact first goal to paste.
Read this guide once, do the one-time setup, then paste that goal.

## The core idea

Raya already ships the three things this needs. Native goals let you state a durable
objective in chat with `/goal`, and the loop keeps working across turns until the
objective is proven done. The in-editor browser gives the agent a real Chrome it can
navigate and screenshot beside the chat. The smoke test runs a scripted walkthrough,
screenshots each step, and gates goal completion, so "done" has to be earned with
evidence rather than claimed.

The one piece Raya does not ship is a way to view its own webview outside VS Code.
The chat UI is a SolidJS bundle that the VS Code host loads with injected URIs and a
live backend, so it cannot simply be opened at a web address. That is why the first
goal stands up a small localhost preview harness: a dev-only page that renders
individual presentational components with a mocked VS Code API and fake props. Once
that page is served at a local address, the browser and smoke tools can navigate to
it, screenshot it, and the designer can read those screenshots with its own vision.
The harness is a one-time investment you reuse for every future redesign.

## Why a second editor instance

You are redesigning the interface of the extension you are running. If the designer
edits the webview and you rebuild and reload to see the change, that reload restarts
the extension host, which would interrupt the agent mid-goal. Running the work from a
second editor instance opened on `C:\Users\User\Desktop\raya` keeps the driving agent
in one process while the thing being rebuilt lives in another. The second instance
can be a separate VS Code window running Raya, or Cursor. Either way it must have the
raya folder open as its workspace so the designer edits the fork's real source.

A related limit worth stating plainly: the agent cannot screenshot the actual VS Code
chat panel through the browser tool, because that tool drives its own Chrome, not the
VS Code webview. The localhost preview is what closes that gap. Verifying the real
panel inside VS Code stays a manual glance you do at the end.

## One-time setup

1. Open the second editor instance on `C:\Users\User\Desktop\raya`. This is where the
   designer will edit code and run commands.
2. Create a feature branch so the redesign is isolated and reversible:
   `git checkout -b raya-self-redesign`.
3. Confirm the Qwen provider is wired up. In the running Raya, open Settings, then
   Providers, and check that Qwen (Model Studio) is present with the region base URL
   ending in `/compatible-mode/v1` and a saved key. Then open the Designer agent and
   confirm its model is `qwen/qwen3.8-max`. The settings hub's "Test connection" does a
   model-list call with no inference cost, so you can confirm the key works for free.
4. Install dependencies if you have not already, so the dev build runs: `bun install`
   from the raya root.

## The visual loop, step by step

1. In the second instance's terminal, start the watch build so edits rebundle on save:
   `bun run watch` inside `packages/kilo-vscode`. Leave it running.
2. Start the localhost preview. The first goal creates this harness and its `preview`
   script; after that first run you simply keep it, and launching it is one command
   (for example `bun run preview` inside `packages/kilo-vscode`, serving the preview at
   a fixed local address such as `http://localhost:5199`).
3. In the Raya chat, select the Designer agent so the design work is focused. Auto
   routing would also reach the designer, but selecting it explicitly keeps the first
   run predictable.
4. Paste the goal from `Raya-Self-Redesign-Goal.md`. It begins with `/goal`, so Raya
   arms a durable goal and starts working in the same turn.
5. Watch the loop run. Each pass the designer edits a SolidJS component, the watch
   build rebundles, the agent navigates the in-editor browser to the localhost preview,
   runs the smoke test to step through the component's states and capture a screenshot
   of each, reads those screenshots against the design fundamentals, fixes what is off,
   and goes again. Completion is gated: the goal will not close until the smoke run is
   green and every item in its definition of done is proven.
6. Review at the natural checkpoints. When the designer proposes a token model or a
   restyle you can approve, redirect, or refine before it continues. This is
   collaboration, not a black box.
7. When the smoke test is green and the definition of done is met, the goal completes
   on its own.

## Final verification in the real extension

The preview proves the component in isolation. To see it in the actual chat panel,
rebuild and reinstall the extension from the branch: `bun run snapshot:build` then
`bun run snapshot:install` inside `packages/kilo-vscode`, then reload the VS Code
window. Open the panel and confirm the redesigned component looks right in place, in
both light and dark themes. This is the manual glance the browser tool cannot do for
you.

## Guardrails

Keep the first goal small; one component plus the reusable harness is enough to prove
the whole loop end to end. Stay on the feature branch and commit as milestones land,
so nothing risks the working extension. Match the existing SolidJS idioms in
`packages/kilo-vscode/webview-ui` rather than importing React patterns, since the
webview is SolidJS. Mark every fork addition with a `// raya_change` comment so it
stays easy to find and, where useful, send upstream. And remember the preview harness
is dev-only; it is a tool for seeing the UI, not something that ships in the VSIX.
