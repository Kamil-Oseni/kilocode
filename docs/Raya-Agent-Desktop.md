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

This new tool is pending focused verification and global installation. Existing skill installation and the earlier two-worker CLI check do not prove it has been discovered or used by an installed Raya worker. Its permission is separate from the existing native desktop panel; it does not change that panel's grants or silently expand a routine's allowed tools. No broad model campaign is required.

Run one authorized background app task through Raya's actual worker routing and verify saved output, cancellation and cleanup. Then route native desktop requests through a provider adapter if the CLI path proves useful. Do not claim the component checks prove full routine completion or that this replaces the native desktop UI.

No broad test suite or extension rebuild is required for this skill-only installation. Existing sessions may need a fresh Raya conversation/backend reload to discover newly installed global skills.

## Removal

Remove the optional global skill directory to stop discovery on the next reload. Keep or remove the versioned binary directory separately after confirming no session is using it. No extension rollback is required because its bundled native desktop code was not changed.
