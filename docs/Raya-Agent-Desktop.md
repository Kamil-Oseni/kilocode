# Vercel Agent Desktop for Raya

Installed on 2026-11-01 as an optional on-demand CLI skill. The existing native desktop panel, input driver and permission system remain unchanged. The earlier routine/build goal remains paused.

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
- A temporary multi-agent session started with tracing off. Two distinct worker IDs successfully queried that session, then `session end` sealed it. No application edits or real cursor movement were performed.
- The installed Raya CLI, invoked from `D:/Raya/Workspaces/WebsitePilot`, returned exactly one `raya-agent-desktop` skill from the global config directory, with trusted global provenance. No local project copy supplied that result.
- The temporary session ended and no `agent-desktop` process remained afterward.
- A first session-start attempt without `--cursor` was refused because multi-agent mode requires it. The accepted command included `--cursor`; it reported `rendered: false`. Visible cursor rendering and multi-worker application actions remain unverified.

## Remaining integration

Run one authorized background app task through Raya and verify saved output, no user focus/mouse disruption, cancellation and session cleanup. Then route native desktop requests through a provider adapter if the CLI path proves useful. Do not claim that discovery/session checks prove full worker task completion or that this replaces the native desktop UI.

No broad test suite or extension rebuild is required for this skill-only installation. Existing sessions may need a fresh Raya conversation/backend reload to discover newly installed global skills.

## Removal

Remove the optional global skill directory to stop discovery on the next reload. Keep or remove the versioned binary directory separately after confirming no session is using it. No extension rollback is required because its bundled native desktop code was not changed.
