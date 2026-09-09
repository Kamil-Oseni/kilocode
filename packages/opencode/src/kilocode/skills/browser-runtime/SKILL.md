---
name: browser-runtime
description: Capability reference for Raya browser skill version 4.
metadata:
  version: "4"
---

# Browser runtime contract, version 4

## Execution and recovery

Evaluation candidates are parsed before execution; the selected expression, script or async body runs once. Runtime exceptions, including runtime SyntaxError and promise rejection, never select another wrapper. Navigation, clicks, typing, selection, scrolling, evaluation and smoke work are not automatically retried once dispatched. An uncertain outcome preserves the current page; inspect the destination before issuing a fresh action. Read-only snapshots/screenshots may retry within existing bounds. A syntax/target preflight failure is distinct from an action that may have taken effect. A failed smoke assertion returns its structured report without restarting earlier steps.

The extension bridge binds each request ID to its canonical payload and directory. Identical requests reuse retained outcomes; changed content under the same ID is rejected. Lost reply delivery does not rerun the browser action. Receipts last for that bridge instance, retain at most 1,024 request identities and at most 64,000 UTF-8 serialized bytes per result, and never expire or evict an in-flight identity. Oversized results retain a non-replay marker. Capacity exhaustion rejects new work before dispatch; reconnecting does not clear capacity. Review unresolved outcomes before intentionally reloading the extension, which discards local receipts and cannot establish old outcomes. Recovered pending requests without a local receipt are refused for inspection, not replayed. These are process-local protections, not durable exactly-once execution across a host restart.

This reference describes the model-facing BrowserTools in `kilocode/tool/browser-host.ts` and protocol in `kilocode/browser/protocol.ts`. Use live tool schemas when available; report mismatches instead of guessing parameters. These tools are exposed to the VS Code client and require a connected extension browser host. Other clients can discover this guidance without having browser tools. Availability in the skill list does not establish a connected host or permission to use it.

| Tool | Parameters | Evidence and limits |
|---|---|---|
| `browser_frames` | `action: "list", tab_id`; or `action: "resolve", tab_id, parent_frame_id, selector` | Frame document IDs, parent relation, URL/name and main-frame flag. Resolve exactly one observed iframe element. |
| `browser_tabs` | `action: "list"`; `action: "open", url`; `action: "select"` or `"close", tab_id` | Stable IDs, URL/title, selected flag and popup opener ID. Opening selects the new tab; popups do not. |
| `browser_navigate` | optional `tab_id`, `url` (absolute URL) | Resulting shared page URL/title; inspect a fresh snapshot for controls. |
| `browser_snapshot` | optional `tab_id` | Accessibility-oriented current page snapshot; it may omit visual or off-frame content. |
| `browser_click` | `tab_id`, `selector` | Action result, not a saved-record guarantee. |
| `browser_type` | `tab_id`, `selector`, `text`, optional `submit` | Replaces editable text; `submit: true` presses Enter and may mutate external state. Defaults false. |
| `browser_select` | `tab_id`, `selector`, `values` (array) | Select element values; verify the resulting selection. |
| `browser_scroll` | `tab_id`, `delta_y`, optional `delta_x`, optional `selector` | Scroll page or observed container by pixels. |
| `browser_screenshot` | optional `tab_id`, optional `full_page` | Image attachment for the current rendered page; full_page defaults false. |
| `browser_evaluate` | `tab_id`, `expression` | Bounded serialized page evaluation. Prefer ordinary interaction tools; use narrowly scoped DOM inspection when necessary. |
| `browser_auth_capture` | `tab_id`, `name` | Captures authenticated storage state for smoke reuse; output contains path/counts, not permission to read or publish secrets. |
| `browser_smoke_test` | `tab_id`, `name`, optional `mode`, `steps` | Structured pass/fail, run ID, artifact and failing step; inspect assertions, not only tool completion. |

Every page result identifies its tab; evaluation text and screenshot descriptions include that identity. Pass the observed `tab_id` for mutations, authentication capture and smoke work. Navigation/snapshot/screenshot may omit it only for the single original tab before another tab has ever existed. After opening a tab or popup, list tabs and use explicit IDs even if only one tab remains. IDs are opaque, never reused in a host lifetime, and invalid after restart; closed/unknown IDs fail without opening a replacement. Selecting a tab changes the viewer, not the page identity bound to already queued work. The panel binds input to the displayed frame and rejects stale selection. Closing the selected/last tab leaves no selected page until you select or open one.

Smoke work uses the identified shared page. Authentication storage and cookie restoration belong to the shared browser context, not exclusively to a tab; tab IDs do not isolate accounts. Use explicit frame identity for supported DOM operations; there is no implicit frame selection.

Frame discovery returns document-scoped identities, not tab indices, names or URLs. Supply optional `frame_id` with snapshot, click, type, select, DOM scroll or evaluation. Omission targets the main document. Every supported DOM observation identifies its tab and frame document. Navigation, detachment, replacement and ancestor navigation invalidate old frame IDs, even when the URL/selector remains identical. After a stale-frame refusal, list/resolve frames and observe again. Never replay an uncertain mutation or substitute the main document. Locator waits pin the observed element; they do not choose a replacement document.

`browser_frames` resolution uses an observed selector inside `parent_frame_id`; it must identify exactly one live direct child iframe. Nested frames require resolving each parent/child boundary. Cross-origin frames use the same explicit identity contract. Snapshot/evaluation results identify frame URL separately from the owning page URL/title. Screenshot images, panel coordinates, navigation and authentication remain tab/context-scoped; do not describe a whole-tab screenshot as an iframe-only capture.

Smoke DOM action and visible assertion objects accept optional `frameID` (camel case inside `steps`, unlike top-level `frame_id`). Resolve these document IDs before constructing the run. Frame navigation makes later references stale and produces a failed report requiring fresh observation. Visible assertions identify their frame; screenshot, network and console evidence remains tab-scoped. Authentication is still shared context state.

The `selector` field accepts a legacy selector string or one of these typed targets:

- `{ "kind": "role", "role": "button", "name": "Save" }` matches the exact accessible name and role.
- `{ "kind": "label", "text": "Email" }` matches the exact associated label.
- `{ "kind": "testid", "value": "saved-record" }` matches an observed test ID.

Each object optionally accepts `scope`, an observed selector for exactly one container. For two Save buttons, inspect the surrounding form and use its observed scope; do not choose the first match. Semantic target and scope must each match exactly one element; missing or ambiguous matches fail before interaction. Actions retain Playwright strict resolution if the page changes between that check and execution. Refresh state before retrying. Target objects work for click, type, select, optional container scroll, smoke actions and visible assertions. Names and labels are literal exact strings, not regexes. Legacy strings retain existing host locator behavior, including the button-name adapter for clicks.

Observe labels/attributes before choosing a target. There is no stable snapshot-reference protocol: do not turn an invented `ref=e1` into an action. When a snapshot omits a needed attribute, use bounded DOM inspection to establish it before use. Do not inspect cookies, storage, passwords, or unrelated application internals through evaluation.

Smoke `steps` is an array of 1-100 entries. Each entry has `id`, `title`, optional `action`, and 1-100 `assertions`. Supported action `kind` values: `navigate` (`url`), `click` (`selector`), `type` (`selector`, `text`, optional `submit`), `select` (`selector`, `values`). Supported assertions:

- `visible`: `selector`, optional `text`.
- `network`: `url`, optional numeric `status`.
- `console`: numeric `max`, optional `level` (`error`, `warning`, `log`, `info`), optional `message`.

Use `mode: "exploratory"` for steps derived from current intent and observations; otherwise the default is `scripted`. The first smoke run captures current authentication when no saved state exists. Capture names identify reusable state: confirm the account and intended target before reuse; do not assume current page login changed an existing saved capture. Scope network assertions to the intended endpoint and status, and console assertions to the relevant messages. Attach a visible-state assertion to user-visible outcomes.

Version 4 has no implicit frame selection, coordinate click, upload, download completion tracking, viewport resize, or automated login/challenge handover operation. Do not invent tool names or emulate missing transfer/identity controls through evaluation or shell commands. A relevant connector or explicitly authorized manual user step can supply missing work; inspect the destination afterward and identify which evidence the browser could not obtain. These limits are unfinished runtime capabilities, not completed acceptance coverage.
