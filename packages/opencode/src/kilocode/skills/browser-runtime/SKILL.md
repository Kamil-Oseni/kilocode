---
name: browser-runtime
description: Capability reference for Raya browser skill version 2.
metadata:
  version: "2"
---

# Browser runtime contract, version 2

This reference describes the model-facing BrowserTools in `kilocode/tool/browser-host.ts` and protocol in `kilocode/browser/protocol.ts`. Use live tool schemas when available; report mismatches instead of guessing parameters. These tools are exposed to the VS Code client and require a connected extension browser host. Other clients can discover this guidance without having browser tools. Availability in the skill list does not establish a connected host or permission to use it.

| Tool | Parameters | Evidence and limits |
|---|---|---|
| `browser_navigate` | `url` (absolute URL) | Resulting shared page URL/title; inspect a fresh snapshot for controls. |
| `browser_snapshot` | `{}` | Accessibility-oriented current page snapshot; it may omit visual or off-frame content. |
| `browser_click` | `selector` | Action result, not a saved-record guarantee. |
| `browser_type` | `selector`, `text`, optional `submit` | Replaces editable text; `submit: true` presses Enter and may mutate external state. Defaults false. |
| `browser_select` | `selector`, `values` (array) | Select element values; verify the resulting selection. |
| `browser_scroll` | `delta_y`, optional `delta_x`, optional `selector` | Scroll page or observed container by pixels. |
| `browser_screenshot` | optional `full_page` | Image attachment for the current rendered page; full_page defaults false. |
| `browser_evaluate` | `expression` | Bounded serialized page evaluation. Prefer ordinary interaction tools; use narrowly scoped DOM inspection when necessary. |
| `browser_auth_capture` | `name` | Captures authenticated storage state for smoke reuse; output contains path/counts, not permission to read or publish secrets. |
| `browser_smoke_test` | `name`, optional `mode`, `steps` | Structured pass/fail, run ID, artifact and failing step; inspect assertions, not only tool completion. |

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

Version 2 has no model-facing tab inventory/switch, popup selection, frame selection, coordinate click, upload, download completion tracking, viewport resize, or automated login/challenge handover operation. Do not invent tool names or emulate missing transfer/identity controls through evaluation or shell commands. A relevant connector or explicitly authorized manual user step can supply missing work; inspect the destination afterward and identify which evidence the browser could not obtain. These limits are unfinished runtime capabilities, not completed acceptance coverage.
