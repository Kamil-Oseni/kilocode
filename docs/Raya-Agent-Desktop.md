# Vercel Agent Desktop for Raya

Installed on 2026-11-01 as an optional on-demand CLI skill. The existing native desktop panel, input driver and permission system remain unchanged. The user subsequently resumed routine work with a constraint to preserve RAM for Claude and Node.

## Installed components

| Item | Value |
|---|---|
| Upstream | https://github.com/vercel-labs/agent-desktop |
| Release | v1.0.2, official Windows x64 archive |
| License | Apache-2.0; copied beside the binary |
| Binary | `D:/Raya/Services/ComputerUse/AgentDesktop/v1.0.2/agent-desktop.exe` |
| Download | 1,578,236 bytes |
| Executable | 3,464,704 bytes |
| Archive SHA-256 | `2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222` |
| Everyday skill | `C:/Users/kamil/.config/kilo/skills/raya-agent-desktop/SKILL.md` |
| Machine receipt | `C:/Users/kamil/.config/kilo/skills/raya-agent-desktop/install.json` |
| Source skill | `.kilo/skills/raya-agent-desktop/SKILL.md` |

The machine receipt pins the binary hash and release URL. The archive hash was checked against GitHub's release-asset digest before extraction/execution. This establishes agreement with the official published asset, not a separate code-security certification.

## What it provides

Background UI Automation actions are the default. They do not move the physical mouse or take focus; unsupported semantic operations refuse rather than silently switching to physical input. Windows physical typing, dragging, right-clicking and some other actions still require headed mode. Minimized windows and some covered Chromium windows remain limitations.

One job may create a multi-agent session with separate labeled cursor profiles. Each worker receives the session ID and its own agent ID. The upstream tool serializes low-level interaction delivery, but apps and document state remain shared. Parents must serialize workers targeting the same window. This skill is guidance, not a new enforced Raya window-lock service.

Skills load on demand, keeping the full desktop manual out of ordinary conversation. The upstream binary carries version-matched desktop/platform guides. No model weights, Ollama process, scheduled task or always-running desktop daemon were installed.

## Verification actually performed

- The downloaded binary returned version 1.0.2 and JSON envelope 2.5.
- `status` reported Windows accessibility granted and the supported desktop surfaces.
- An initial temporary multi-agent session started with tracing off. Two distinct worker IDs successfully queried that session, then `session end` sealed it. That initial check did not edit applications; the later application check is described below.
- The installed Raya CLI, invoked from `D:/Raya/Workspaces/WebsitePilot`, returned exactly one `raya-agent-desktop` skill from the global config directory, with trusted global provenance. No local project copy supplied that result.
- The temporary session ended and no `agent-desktop` process remained afterward.
- A first session-start attempt without `--cursor` was refused because multi-agent mode requires it. The accepted command included `--cursor`; it reported `rendered: false`. Visible cursor rendering remains unverified.

## Practical background check

One small native WinForms process exposed two disposable windows. Two distinct worker IDs in one multi-agent session concurrently set different fields through `ValuePattern.SetValue`, then clicked their own Save buttons through `InvokePattern.Invoke`. Both field writes returned `delivered_verified`. Save clicks returned `delivered_unverified`; fresh UI snapshots showed the correct Saved labels, and independent file reads confirmed the exact two outputs.

The fixture recorded the same unrelated foreground window at launch, edit and save for both windows. No headed or physical-synthetic action was used. Continuous foreground state and physical pointer position were not sampled, so this is bounded evidence rather than a guarantee for every application.

Observed resident memory: two cursor processes approximately 21.5 MB combined; the fixture approximately 36.7 MB. Free system RAM was 10.59 GiB during the check. These are point observations, not peak or production workload measurements. Both windows closed through observed semantic refs, the session ended and no fixture/cursor processes remained. Claude, Node, VM and model processes were not changed.

Local evidence is retained at `.tmp/agent-desktop-live-20261101/result.json`, with hashes of saved files, UI readbacks, click receipts and foreground event logs. This check used CLI worker identities, not two LLM-driven Raya workers. It does not prove native panel integration, app-independent reliability or cancellation of an in-flight action.

## Remaining integration

The optional plugin source is `.kilo/plugins/raya-agent-desktop.ts`, with its tool implementation in `.kilo/skills/raya-agent-desktop/tool.ts`. It uses the existing Raya plugin and permission APIs. Install the reviewed plugin globally so the existing provenance rules can admit it for permitted routine workers; loose tool scripts remain untrusted, and project-local copies do not gain global trust. Each call owns an overlay-free Vercel session, permits only inventory/snapshot/one field write/one semantic click, and returns the action receipt plus fresh readback. It checks the binary hash against the reviewed installation receipt. Names and values are argument data rather than shell commands; action values follow an option terminator. App/window/title must match the fresh snapshot. Concurrent calls to the same window are refused within the current backend; this is not a cross-backend transaction lock.

Focused verification on November 2 passed: selected plugin/transitive typing, syntax lint on both files (zero warnings/errors), and a direct plugin API check using the real pinned CLI. That check performed nonexistent-app inventory, confirmed its owned session ended, and checked supplied-context permission denial and already-cancelled refusal before dispatch. The complete guarded batch took 5.281 seconds, used no model or UI input, and ended naturally with joined streams and an empty owned process family; minimum available RAM was 11.53 GiB. Evidence is retained in `.tmp/new-pc/vercel-plugin-checks-20261102.json` and `vercel-plugin-component-20261102-result.json`. The supplied permission hook is not proof of installed Raya authorization, and the already-cancelled case does not prove cancellation during an action.

The installed `416b437ad0` CLI subsequently discovered and invoked the plugin from an isolated global-config directory through its actual plugin loader, tool registry and `debug agent --tool` dispatch. Empty-app inventory and the owned Vercel session's cleanup returned `ok: true`. The entire CLI exited 1 with a separate interrupted-search retirement error; this is a successful tool-dispatch observation, not a clean runtime pass. The initial fixture had placed its explicit allow before a wildcard deny, and correctly refused execution; that original refusal remains saved. Receipts and streams are retained as `.tmp/new-pc/vercel-installed-probe-20261102{,-v2}.*`.

The shutdown error led to a narrow Core fix: only a pure cancellation observed after scoped finalizers, root-binding recheck and profile-lease release avoids permanently failing later retirement. The caller still receives cancellation; actual cleanup or ownership failures remain failures. A real child-process cancellation reproduced the false retirement failure before the fix. The corrected case plus three existing real filesystem/ownership failure controls passed (four cases, 25 assertions). Scoped source typing and lint passed. This source fix still needs the build chat's combined package/install and corrected CLI observation.

That correction is now installed in `009c53ec5e`. Its exact CLI hash was checked before the corrected private probe. Actual plugin dispatch, empty-app inventory, Vercel session cleanup and CLI retirement all completed with natural exit 0, joined streams and an empty owned process family in 9.281 seconds; minimum free RAM was 12.50 GiB. This probe used the real published SDK installed in its private config prefix, rather than relying on a development-worktree import. Receipt: `.tmp/new-pc/vercel-installed-probe-20261102-v3.json`. It proves this model-free installed CLI path; actual routine/LLM actions and everyday global installation remain separate.

The build chat has now published the plugin and real SDK globally, preserving existing settings, permissions, installation manifest and native binary. Normal-profile `009c53ec5e` discovery ended naturally with exit 0 and found the tool. Auto correctly leaves it disabled under its curated tool policy. Global provenance alone does not grant a computer child access: its hard ceiling permits native desktop tools only, and the plugin context does not carry the native desktop delegation proof. The Generalist route is being checked separately. This is installed discovery, not a completed routine-worker action.

### Native worker adapter decision

Connect Vercel through the existing native Desktop host bridge rather than widening permissions for the standalone plugin. Keep `TaskComputer` admission and its durable parent/child/grant/window binding. Add separate built-in snapshot and action tools, with snapshot requiring `observe`, field writes requiring `keyboard`, and semantic clicks requiring `pointer`. Read children retain their current ceiling. Parent denials, observe-only grants, pause/revocation and sensitive-action policies remain effective.

The implementation boundary is `kilocode/tool/desktop-background.ts`, native tool registration and Computer Use tool allowlists, typed variants in `kilocode/desktop/protocol.ts`, and an extension-owned adapter reached from `services/computer-use/desktop-bridge.ts`. Regenerate the SDK from the protocol change. Existing `DesktopBridge.observe()` explicitly requires the selected window to be foreground; existing interaction paths may use physical input. Neither path is suitable for the background adapter.

Resolve the exact authorized native HWND into Vercel's `w-<decimal HWND>` identifier using integer-safe conversion. Upstream `window_ops.rs` defines that mapping. App name, title or PID alone cannot establish a match. Recheck Raya's native identity (process birth and window class) before observation and immediately before mutation; also retain Vercel's own process-instance and handle checks. A hosted-frame identity disagreement must refuse rather than choosing a similarly named window. Return only the authorized window's tree and use a fresh, unique accessible role/name to select the control.

The host must revalidate the active grant and sensitive category after resolving that fresh control and before dispatch. It must serialize mutations per canonical window, never activate a window or fall back to physical input, retain any delivery receipt if readback fails, and never automatically replay a delivered action. Cancellation must stop the owned command and independently end its Vercel session; cleanup failure remains visible. An action whose delivery is uncertain must be reported as uncertain, not as safely cancelled before delivery.

This is the implementation decision, not an implemented adapter. The focused acceptance is one selected disposable app window, a real saved field result, observe-only and wrong-window refusals, and cancellation/cleanup through the actual worker route. Do not open the fixture while the user's main-screen restriction is active. No broad model campaign is required.

For global installation, copy the reviewed plugin entry to `~/.config/kilo/plugins/raya-agent-desktop.ts` and its implementation to `~/.config/kilo/skills/raya-agent-desktop/tool.ts`. Update that skill's `SKILL.md` together with those two files, preserving the existing pinned `install.json` and versioned binary. Save any prior files before replacement. Do this only after active normal-profile jobs have closed; existing backends need a reload before discovery. Do not silently widen a worker's allowed tools.

### SDK dependency setup

The private probe originally resolved `@kilocode/plugin` from its development checkout; that is not a durable global dependency. Use the real published `@kilocode/plugin@7.4.23`, which matches the tool API and pins SDK 7.4.23, Zod 4.1.8 and Effect 4.0.0-beta.83. Its [official registry metadata](https://registry.npmjs.org/@kilocode%2fplugin/7.4.23) supplies the tarball integrity. The downloaded 12,089-byte tarball matched that SHA-512 integrity. Do not substitute an unpublished local snapshot SDK or a junction to a worktree.

A private cache and dependency tree are prepared in `.tmp/new-pc/vercel-sdk-7.4.23`. Standard npm installation of the exact published version completed with scripts, audits and funding requests disabled. Its actual npm-generated `package.json` and lockfile contain the pinned SDK; lock integrity agrees with the registry. Qualification: `.tmp/new-pc/vercel-sdk-cache-qualified-20261102.json`. The prepared cache is outside the protected user profile.

Deploy only after the build chat releases preservation and all owned normal-profile jobs close:

1. Snapshot the current global plugin/skill files, SDK dependency metadata and `node_modules` identity/content. Recheck those exact observations before writing. Preserve `kilo.json`, `raya.json`, permissions, credentials, installation manifest and binary.
2. If global dependency metadata or `node_modules` is absent, confirm absence again. Use the prepared cache for an offline exact-version npm install with scripts/audit/funding disabled. Do not use global `npm ci` over an existing module tree: it can remove unrelated modules. If both metadata files and the entire `node_modules` root are freshly confirmed absent, the genuine staged metadata can be published and an offline `npm ci` used for that new tree only.
3. If unmanaged global modules exist without metadata, do not run a pruning npm operation over them. Add only missing files from the genuine staged npm tree with create-new semantics, rejecting changed/colliding packages. Publish the genuine generated dependency metadata only after its declared packages are present; preserve every prior unmanaged file. If existing dependency metadata differs from the observed baseline, stop this deployment rather than overwrite it.
4. Publish the plugin entry last, after its implementation and dependency resolution are verified. Use only one `.ts` or bundled `.js` entry, never duplicate entries. Record created paths and hashes, keep backups, and reload the backend without opening a user window.
5. Verify actual resolution from the global plugin directory selects the installed published SDK, then run the narrow installed CLI check. The existing backend skips its automatic SDK install when the real declared dependency names are already locked and `node_modules` exists. This avoids a snapshot-version network fallback; a standalone bundle alone would not suppress that backend installer.

The private setup and probes above did not change global dependency files, plugin entry or permissions. The build chat subsequently applied the global deployment with create-new dependency copies and published the plugin entry last; the recipe remains here for recovery or a new installation. Installed discovery does not establish routine-worker availability.

Run one authorized background app task through Raya's actual worker routing and verify saved output, cancellation and cleanup. Then route native desktop requests through a provider adapter if the CLI path proves useful. Do not claim the component checks prove full routine completion or that this replaces the native desktop UI.

No broad test suite or extension rebuild is required for this skill-only installation. Existing sessions may need a fresh Raya conversation/backend reload to discover newly installed global skills.

## Removal

Close owned desktop jobs and remove the optional global plugin entry `~/.config/kilo/plugins/raya-agent-desktop.ts` before removing its skill directory or implementation, so discovery cannot retain a broken import. Reload the backend after removal. To undo an update, restore the saved plugin, implementation and skill guidance together while preserving the matching installation manifest. Keep or remove the versioned binary directory separately after confirming no session is using it. Removing this optional plugin does not roll back the separately packaged Core shutdown fix.
