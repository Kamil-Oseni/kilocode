# Raya Mobile Companion — Build Plan

This document is a build plan only. Nothing here is implemented yet. It describes how to let you watch and steer Raya's work on your home PC from a phone: view active sessions, stream the live transcript, send prompts, approve permission prompts, and review frontend and design work in a canvas.

## The core idea

Raya's desktop clients are not the agent. The agent, tool runtime, and session store all live inside a local `kilo serve` process that exposes an HTTP + SSE API, and every client — the VS Code sidebar, the editor tabs, the Agent Manager — is just a consumer of that API. A phone app is one more consumer. It needs no agent logic of its own. It authenticates to your server, lists sessions, subscribes to the same event stream the desktop uses, posts prompts, and renders diffs and design artifacts.

That framing matters because it tells us where the real work is. The hard parts are not the model or the tools; they are reaching the server securely from outside your home network and building a client that reads well on a small screen. Treat the agent as solved and spend the effort on transport, authentication, and presentation.

## Making the server reachable

The server must never be exposed raw to the public internet. `kilo serve` assumes a trusted local caller and is not hardened as an internet-facing endpoint. There are three sound ways to reach it, in the order you should prefer them.

A private mesh VPN is the right default. Install Tailscale (or plain WireGuard) on both the PC and the phone, and the phone reaches the PC over a private, encrypted address as if the two were on the same LAN. There is no public surface, it works from any network, and you can stand it up in an afternoon. For a personal tool, and even for a small trusted team, this is the correct answer and it removes the entire class of "someone found my endpoint" problems.

A reverse tunnel is the fallback when you want a plain URL and no VPN client on the phone. Cloudflare Tunnel or ngrok publishes a public hostname that forwards to the local server. This is more convenient and considerably more dangerous, because now anyone who learns the hostname can knock on the door. It is only acceptable behind real authentication and TLS, described below, and it should be a deliberate choice rather than the starting point.

A hosted relay is the heaviest option and only earns its cost once several developers need in without each joining your VPN. You run a small always-on service that both the PC and the phones connect out to, and it brokers traffic between them. Defer this until team scale forces it.

Start with Tailscale. It gives you private authenticated reach immediately and lets you postpone the public-endpoint security burden entirely.

## Authentication and multiple users

For just you over Tailscale, device-level identity plus a single bearer token held by the server is enough, because the network itself is already private and authenticated. The moment other developers use it, that is no longer sufficient and you need a real auth layer sitting in front of `kilo serve`.

That layer should issue short-lived tokens from an identity provider — GitHub OAuth is a pragmatic choice given your team already lives there — scope every session to its owner so people cannot read each other's transcripts, and record an audit log of who ran what and when. Because all traffic already flows through the HTTP API, this is a gateway and middleware concern rather than a change to the agent core; you are wrapping the server, not rewriting it. Neon is a natural home for the user records, tokens, and the activity log, and it is already available in this workspace.

## The mobile client

Build it cross-platform. React Native (or Expo) gives you real iOS and Android apps; a PWA lets you skip the app stores while you prove the concept and is the faster way to get something on your phone. Either way the client is thin, and it needs four surfaces.

The session list is the home screen: active and recent sessions with live status, so you can see at a glance what is running, what is blocked, and what finished. The live transcript is the heart of the product — it subscribes to the same SSE stream the desktop consumes, so you watch tool calls, file edits, and goal progress arrive in real time, exactly as they appear on the PC. The composer lets you send prompts, arm `/goal`, pause and resume goals, and, critically, answer permission prompts, so a run that hits an approval wall while you are away does not simply stall. The review surface renders diffs so you can read what the agent changed and keep or undo it.

Of these, the transcript and streaming carry most of the value. The ability to watch a goal execute on your PC from your phone, and to steer it with a prompt or a pause, is the feature that makes the rest worth building.

## The design canvas on mobile

Design and frontend work should be shown, not merely described. There are two complementary paths. For web UIs, have the PC serve a live preview — a running dev server or a built bundle — and load it in a webview inside the app over the same tunnel, so you see the actual rendered screen. For richer or interactive artifacts, reuse the canvas pattern: a self-contained view the agent produces, rendered in the app's webview. Pair either path with the screenshots the agent already captures, so you get an instant still image even before the live preview finishes loading.

## Recommended build order

1. Confirm the API contract first. Run `kilo serve` locally and drive it entirely from `curl` — create a session, subscribe to the SSE stream, post a prompt, fetch a diff. This nails down exactly what the client consumes before any app code exists, and it is the cheapest possible validation.
2. Put the server on Tailscale and reach it from your phone's browser, with no app yet. Prove connectivity and live streaming end to end.
3. Build the client against that: session list, then live transcript, then composer. Ship the read-and-steer loop before anything else.
4. Add the review and diff surface, then the design-canvas webview.
5. Only then layer in real multi-user authentication — identity provider, per-user scoping, audit log — and only if teammates are actually coming aboard.

## Design cautions to bake in early

Two failure modes will otherwise surface late and hurt. The client must degrade gracefully when the PC sleeps or drops off the network: show a clear "backend unreachable" state and resume the SSE stream on reconnect rather than silently freezing. And permission prompts must be answerable from the phone, or an unattended goal that needs approval will hang indefinitely. The agent self-pause capability already in Raya helps here — an agent that hits an approval wall can pause and wait for you to approve remotely instead of blocking — but the mobile composer has to surface and resolve those prompts for the loop to actually close.
