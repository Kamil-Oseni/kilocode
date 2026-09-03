# Ideas from the Grok Bot Piece for Raya and Its Subagents

Source: [x.ai/news/designing-grok-bot](https://x.ai/news/designing-grok-bot). The essay's central move is treating agents as persistent identities you delegate to, rather than chat sessions you operate, and most of its lessons map cleanly onto systems Raya already has half-built. This file captures the directions worth pursuing; the concrete, pick-up-cold plans for the most actionable ones live in `medium.md` (scheduled/recurring agents) and elsewhere in this folder.

## Presence as state — the strongest near-term fit

Grok encodes idle/working/waiting/blocked/done into the agent's avatar so a glance tells you what's happening without reading a transcript. Raya streams every tool call, which is the opposite failure mode the essay warns about — users mostly want reassurance, not a firehose. Now that the ask tool works, the highest-value version of this is making "blocked/waiting on you" a distinct, unmissable state on the goal banner and subagent cards, so a delegated run that's stuck on an `ask_options` question surfaces immediately instead of looking like it's still working. Pair that with collapsing a subagent's transcript to a one-line current-action with expand-on-demand, and Raya's execution view stops overwhelming and starts reassuring.

## What Raya already does well — validated before investing elsewhere

The essay validates two things Raya already does well, which is worth knowing before you invest elsewhere. The Chief-of-Staff coordinator it describes — give direction to one agent that routes to specialists — is exactly Raya's Chief/Auto routing; the piece's refinement is that capabilities should be shared at the account level while context stays scoped to each role. Raya's subagents (coder, designer, generalist, accountant) are currently ephemeral roles with shared project memory; scoping memory per role (a designer remembers design decisions, an accountant remembers financial context) is a concrete, additive upgrade. And the their-computer-not-yours model with three access levels — status, preview, takeover — is precisely the design Raya's browser panel already implements with its manual-takeover handoff. The lesson is to generalize that same status/preview/takeover pattern to the other agent surfaces (the terminal, the canvas) rather than inventing a new interaction each time.

## Routines — the biggest untapped idea

The biggest untapped idea is routines — work that begins without a prompt. Raya's goals are persistent but always user-initiated; Grok's routines start from a schedule or an event (a morning briefing, watching CI, reacting to a webhook). This is already the highest-leverage item in your own `to-build/medium.md` (scheduled/recurring agents), and the essay is a strong argument to prioritize it, because it's what turns Raya from a tool you drive into a coworker who shows up with work already done.

## The disappearing interface — a discipline, not a feature

Finally, the piece's quieter discipline — the disappearing interface, removing knobs and capping scope (50 bots, 6 per group chat) — is a useful counterweight: the settings search we added makes things findable, but the deeper move is asking, per feature, whether it helps you delegate or just gives you one more thing to manage.
