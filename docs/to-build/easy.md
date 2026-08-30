# To Build — Easy

Mostly UI/config work that reuses existing Raya primitives (canvas, in-editor review decorations, the global permissions toggle, plan mode). Low risk, small surface, no new infrastructure.

Each plan below is written so any agent can pick it up cold. File paths are relative to the repo root. Mark all edits to shared opencode files with `kilocode_change` / `raya_change`; files under `packages/kilo-vscode/` and `packages/opencode/src/kilocode/` need no markers.

---

## 1. In-editor inline chat/edit trigger (Cmd/Ctrl+I)

**Goal.** Pressing `Cmd+I` / `Ctrl+I` in an editor opens a small prompt for the current selection (or cursor line), sends it to the active Raya session with the selection as context, and streams the edit back. Source: Cursor / Copilot inline chat.

**What already exists.** Selection-based editor commands (`raya.explainCode`, `raya.fixCode`, `raya.improveCode`) live in `packages/kilo-vscode/src/services/code-actions/register-code-actions.ts`. They read the editor via `getEditorContext()` in `packages/kilo-vscode/src/services/code-actions/editor-utils.ts` (returns `{ filePath, selectedText, startLine, endLine, diagnostics }`, requires a non-empty selection) and forward a prompt to the webview with `provider.postMessage({ type: "triggerTask", text })`. The webview consumes `triggerTask` in `packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx` (~line 807) and calls `session.sendMessage(...)`, which posts `sendMessage` back to the extension, which calls `client.session.promptAsync(...)` in `packages/kilo-vscode/src/KiloProvider.ts` (~line 4210). No `cmd+i` binding exists yet.

**Implementation steps.**
1. Add a `raya.inlineEdit` command to `contributes.commands` in `packages/kilo-vscode/package.json`, plus a keybinding `cmd+i` / `ctrl+i` with `when: editorTextFocus`, and an `editor/context` submenu entry alongside the existing `raya.editorContextMenu` items.
2. Register the command in `register-code-actions.ts` (or a new `packages/kilo-vscode/src/services/code-actions/inline-edit-commands.ts` following the `registerCheckpointCommands` module shape). Use `getEditorContext()`; if there is no selection, fall back to the current line range.
3. Prompt the user for the instruction with `vscode.window.showInputBox` (fast path) OR reveal the sidebar and pre-fill the composer. For the minimal easy version, use `showInputBox`, then compose a prompt string that includes the file path, the line range, and the selected text fenced in a code block, and send it via the existing `triggerTask` message so no new streaming path is required.
4. Ensure the selection range travels as context. Simplest: embed it in the prompt text (no protocol change). Optional improvement: extend the `editorContext` object built in `KiloProvider.gatherEditorContext` (~line 5333) with an `activeSelection: { file, startLine, endLine, text }` field and thread it through `session.promptAsync`.

**Acceptance criteria.** With a selection and cursor in a file, `Cmd+I` prompts for an instruction, the resulting message appears in the active session referencing the exact file + lines, and the agent's edit streams back and shows up in the normal in-editor review flow. Works in both light and dark themes. No new keybinding conflicts (`cmd+i` is unused today).

**Notes / scope.** The truly "easy" version routes through the existing sidebar composer via `triggerTask`. A dedicated in-editor overlay widget (Cursor-style floating input anchored at the cursor) is a larger UI effort — defer that to medium if requested.

---

## 2. Per-file / per-chunk keep-undo in the editor gutter

**Goal.** Let the user accept or reject edits at hunk granularity from the editor gutter, not just whole-session Keep all / Undo all. Source: Copilot total-changes diff, Cursor.

**What already exists.** In-editor review is implemented in `packages/kilo-vscode/src/edit-review/InEditorReview.ts` with the diff parser in `packages/kilo-vscode/src/edit-review/patch-ranges.ts` (`addedRanges(patch): LineRange[]` walks unified-diff hunks and returns new-side `+` ranges). It applies green whole-line decorations (`diffEditor.insertedLineBackground`) and renders three CodeLenses at the first changed line: a sparkle label, `$(check) Keep` → `raya.editReview.keepFile`, and `$(discard) Undo` → `raya.editReview.undoFile`. Keep is client-side only (a `dismissed` set); Undo calls `session.discardChanges({ sessionID, directory, files: [review.file] })`. Webview equivalents are in `packages/kilo-vscode/webview-ui/src/components/chat/edit-review.ts`, `VscodeToolOverrides.tsx`, and the Keep all / Undo all cluster in `ChatView.tsx`.

**Critical constraint (read before starting).** The backend `discardChanges` is **file-level only**. See `packages/opencode/src/session/revert.ts` (`SessionRevert.discardChanges` takes `{ sessionID, files?: string[] }`) and `packages/opencode/src/kilocode/session/revert.ts` (`KiloSessionRevert.discardAll(..., only?: string[])` matches by file path). Snapshot revert (`Snapshot.revert`) restores whole files from patch hashes. **There is no range/hunk revert API today.** `addedRanges` parses hunks for display only.

**Scope for this (easy) tier — per-file affordances rendered per hunk.** Surface the existing per-file Keep/Undo more clearly: the CodeLens path already works. The easy improvement is UI-only — render one CodeLens cluster per contiguous changed region (using the `LineRange[]` from `addedRanges`) that still calls the file-level `keepFile` / `undoFile`, so an affordance appears next to each hunk even though the action reverts the whole file. Keep the label honest when the action is file-scoped (e.g. "Undo file").

**Acceptance criteria.** Each changed region in a reviewed file shows its own Keep/Undo affordance in the gutter; actions behave identically to today's per-file controls; green highlights and CodeLens refresh after Keep all / Undo all and after new edits (via `scheduleReview` → `inEditorReview.refresh()`).

**Moved out of this tier.** *True* per-hunk revert (reverting only selected lines while leaving other hunks in the same file) needs a new backend range-revert capability and carries snapshot-desync risk. It now lives as a full plan in `docs/to-build/medium.md` under "True per-hunk (line-range) undo."

---

## 3. Design Mode toggle in canvas

**Goal.** A lightweight visual-tweak mode layered on the live React canvas for quick style/layout adjustments without a full chat round-trip. Source: Cursor Design Mode, Claude Design on-canvas editing.

**What already exists.** Canvas lives in `packages/kilo-vscode/src/services/canvas/` (not in `webview-ui`). `CanvasPanel` (`canvas-panel.ts`, `viewType = "raya.CanvasPanel"`) opens a beside-chat webview whose HTML embeds a sandboxed iframe (`sandbox="allow-scripts"`) that loads `canvas-runtime.js` (built from `canvas-runtime.tsx`) plus the compiled artifact bundle. Messages: the outer webview posts `ready` / `rendered` / `runtimeError` (`CanvasPanelMessage` in `canvas-panel.ts`), and the extension posts `{ type: "data", data }` for the component's `data` prop; the outer host relays to the inner iframe with `source: "raya-canvas-host"`. **There is no canvas toolbar today** — the closest precedent for embedding toolbar/controls in a panel is `packages/kilo-vscode/src/services/browser-automation/browser-panel.ts`, which renders a header (nav/status) inline in its `html()`.

**Implementation steps.**
1. Add a toolbar header to the outer webview HTML in `canvas-panel.ts`, modeled on `browser-panel.ts`'s header. Include a "Design Mode" toggle button styled with VS Code theme variables.
2. Define new messages on `CanvasPanelMessage`: outer → extension `{ type: "designModeChanged"; enabled: boolean }`, and extension/host → inner `{ source: "raya-canvas-host"; type: "designMode"; enabled: boolean }` relayed the same way the `data` message is.
3. In `canvas-runtime.tsx`, handle the `designMode` message: when enabled, render a lightweight overlay that lets the user select rendered elements and adjust obvious style props (spacing, font size, color). Scope this small — for the easy version, support inspecting the hovered element and copying/emitting a change hint back to the agent rather than a full style editor.
4. Emit selected tweaks back to the chat as a follow-up prompt (reuse the chat attachment/prompt path) so the agent can persist them into the `.canvas.tsx` source under `.raya/canvases/`.

**Acceptance criteria.** The canvas panel shows a Design Mode toggle; enabling it activates an overlay in the sandboxed iframe; disabling it returns to normal render; toggling never breaks live rebuilds (`CanvasRefresh` on `.canvas.tsx` change). Theme-aware.

**Notes.** Full WYSIWYG editing that writes back to source is a larger effort; the easy scope is "inspect + emit a change hint to the agent."

---

## 4. Run artifact capture (screenshot / short recording)

**Goal.** Capture a screenshot (optionally a short recording) of a finished canvas/preview run so a completed goal can be verified from an artifact. Source: Cursor cloud-agent demo screenshots/videos.

**What already exists.** The browser panel already streams frames: `packages/kilo-vscode/src/services/browser-automation/browser-session.ts` uses CDP `Page.captureScreenshot` (JPEG base64) and Playwright `page.screenshot`, and `browser-panel.ts` displays them via `postMessage({ type: "frame", data, width, height, url })` into an `<img src="data:image/jpeg;base64,...">`. Image plumbing on the chat side exists too: `useImageAttachments.ts` (`FileReader.readAsDataURL`), `previewImage` handling in `packages/kilo-vscode/src/kilo-provider/editor-actions.ts`, `saveImage()` in `packages/kilo-vscode/src/kilo-provider/save-image.ts`, and `parseImage()` in `packages/kilo-vscode/src/image-preview.ts`. **There is no canvas screenshot path today**, and VS Code has no built-in webview screenshot API — capture must happen inside the webview and be posted out as base64.

**Implementation steps.**
1. In the canvas inner runtime (`canvas-runtime.tsx`) or the outer host script in `canvas-panel.ts`, add a capture routine. Simplest reliable approach: render the artifact to an offscreen `<canvas>` via a small `dom-to-image`/`html-to-image` helper (bundled into the runtime) and call `toDataURL("image/png")`. If bundling a lib is undesirable, capture the sandboxed iframe content the same way the browser panel produces frames.
2. Add messages: outer → extension `{ type: "capture"; data: string /* dataURL */ }`, triggered by a toolbar "Capture" button (reuse the Design Mode toolbar from feature 3).
3. In the extension, reuse `parseImage()` + `save-image.ts` to write the PNG to disk (e.g. under `.raya/canvases/captures/`), and optionally attach it to the session as a message part so the goal's completion audit can cite it.
4. Recording is optional and heavier: defer `MediaRecorder`-based capture to medium unless explicitly requested.

**Acceptance criteria.** A "Capture" control on the canvas panel produces a PNG of the current render, saved to disk and optionally attached to the active session; the saved file opens in the existing image preview. Screenshot fidelity is acceptable for verification (not pixel-perfect).

**Notes.** Keep CSP in mind — the iframe is `sandbox="allow-scripts"`; any capture lib must run inside that sandbox and only post a data URL outward.

---

## 5. Owner "lock a standard design system" flag

**Goal.** A single owner setting that pins one approved design system so generated UI must build against it. Source: Claude Design admin lock. Reuses the existing global owner-toggle pattern.

**What already exists.** The global permissions toggle is the exact template: setting `raya.permissions.grantAllTools` is declared in `packages/kilo-vscode/package.json` under `contributes.configuration.properties` (~line 1158), and `packages/kilo-vscode/src/kilo-provider/grant-all-permissions.ts` reads it with `vscode.workspace.getConfiguration("raya").get<boolean>(KEY, false)`, reacts to `onDidChangeConfiguration` (guarded by `event.affectsConfiguration("raya.<KEY>")`), and calls a backend SDK method (`client.permission.allowEverything`). It is registered in `extension.ts` (~line 66). Design-system integration today is only agent-level: the `designer` subagent and Chief `figma` routing keyword in `packages/opencode/src/kilocode/`, plus optional Figma MCP docs — there is no first-class design-system state in the backend yet.

**Implementation steps.**
1. Declare a new setting in `package.json` `contributes.configuration.properties`, e.g. `raya.designSystem.lock` (boolean, default `false`) and optionally `raya.designSystem.source` (string: repo path or token file) with a clear `markdownDescription`.
2. Create `packages/kilo-vscode/src/kilo-provider/design-system-lock.ts` mirroring `grant-all-permissions.ts`: `const KEY = "designSystem.lock"`, an `enabled()` reader, an `apply()` that pushes state to the backend, and a `registerDesignSystemLock(connection)` returning the config-change disposable.
3. Add a backend surface to hold the flag/source and inject it into design-related prompts. Minimal version: a kilocode HTTP endpoint + a small `RayaDesignSystem` namespace under `packages/opencode/src/kilocode/` that the `designer` agent / `DESIGN_GUIDANCE` prompt consults, so when locked, generated UI is instructed to build against the named system. (Follow the checkpoint feature's pattern: group/handler in `packages/opencode/src/kilocode/server/httpapi/`.)
4. Register `registerDesignSystemLock(connectionService)` in `extension.ts` next to `registerGrantAllPermissions`.

**Acceptance criteria.** Toggling `raya.designSystem.lock` in Raya settings persists and, on activation and on change, pushes the state to the backend without error; when locked, design/UI generation prompts reference the approved system. Default off, safe for users who never flip it.

**Notes.** The setting + wiring is genuinely easy; the backend enforcement depth is a dial — the minimal "inject into prompt" version is easy, while hard enforcement (validating generated output against tokens) belongs in the medium "design-system-aware generation loop."
