<!-- raya_change - Raya marketplace details -->
# Raya

Raya is Eden's private agentic coding IDE. It combines conversational coding, persistent goals, intelligent specialist routing, browser automation, voice interaction, project memory, model usage analytics, and isolated multi-agent work in one VS Code extension.

## Core capabilities

- Persistent `/goal` work with visible progress, steering, verification, review, and reliable discard.
- Global `/self-heal` feedback that categorizes issues and starts isolated repair sessions.
- Auto routing that assigns direct work to a small generalist and delegates specialist work when needed.
- Inline change review with green/red diffs and per-change Keep or Discard controls.
- Push-to-talk and hands-free voice using configurable STT and MiniMax TTS providers.
- An integrated browser with authenticated walkthroughs, smoke testing, and manual takeover.
- Provider, agent, model, speech, goals, and routing settings with secret-storage protection.
- Historical token and cost tracking by provider and model.
- Agent Manager sessions with worktree isolation.

## Useful commands

- `Raya: Open in New Tab`
- `Raya: Open Browser` (`Ctrl+Shift+B`, or `Cmd+Shift+B` on macOS)
- `Raya: Open Settings`
- `Raya: Show Changes`

Type `/` in chat to discover goals, self-healing, review, status, sessions, models, and other controls.

## Privacy

Provider keys are stored in VS Code secret storage. Optional CLI mirrors are written only to gitignored local configuration. Raya does not require a hosted gateway when a direct provider endpoint is configured.
