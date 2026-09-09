---
"raya": patch
---

Fix live canvas, per-file undo, responsive browser, and new-chat titles

- Canvas now initializes esbuild-wasm explicitly from the packaged runtime (with a bounded timeout), so `create_canvas` renders instead of stalling until the host times out. A name-only `update_canvas` now re-renders the persisted canvas, making the create-timeout retry hint followable instead of erroring.
- In-editor per-file Undo steps back a single edit — restoring the previous content — instead of rewinding to the pre-session baseline and deleting text an earlier edit had added.
- The in-editor browser is now genuinely responsive: resizing the panel drives the page's layout viewport so CSS breakpoints fire like a real browser, while staying crisp on HiDPI displays. Pointer and scroll input map to the live viewport.
- New chats no longer display the raw "New session" default title; the tab, header, and history mask it until the generated title from the first prompt arrives, matching the native tab.
