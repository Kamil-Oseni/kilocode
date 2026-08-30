# To Build — Hard

Cloud infrastructure, VM isolation, or deep third-party platform integrations. These require standing up services beyond the local CLI + extension and carry the most operational and security weight. Several build on each other — the cloud-runner (feature 1) is the foundation for handoff (2), the orchestration surface (3), and the GitHub/CI features (4–6, 8).

Each plan is written so any agent can pick it up cold. File paths are relative to the repo root. Mark edits to shared opencode files with `kilocode_change` / `raya_change`; files under `packages/kilo-vscode/` and `packages/opencode/src/kilocode/` need no markers. Regenerate the SDK with `./script/generate.ts` after adding server endpoints.

**Read first — the transport and auth reality.** `kilo serve` (`packages/opencode/src/cli/cmd/serve.ts` → `Server.listen` in `packages/opencode/src/server/server.ts`) exposes the full HTTP + SSE API, but auth today is a single HTTP **Basic** password (`packages/opencode/src/server/auth.ts`, `KILO_SERVER_PASSWORD`) — not per-user tokens. Every cloud/remote feature below assumes a real auth gateway is added in front of it (see the mobile companion's auth section in `docs/Raya-Mobile-Companion-Plan.md` — short-lived tokens from an identity provider, per-user scoping, audit log, Neon for storage). Treat that gateway as a shared prerequisite for features 1–3 and 6.

---

## 1. Cloud / background agents in isolated VMs

**Goal.** Run a Raya session in a provisioned cloud VM with a full dev environment (repo, dependencies, secrets, restricted egress) instead of on the local machine, launchable and observable remotely. Source: Cursor Cloud Agents, Copilot cloud agents, Claude Code on web.

**What already exists.** Headless execution is solved: `kilo run` (`packages/opencode/src/cli/cmd/run.ts`) drives a session non-interactively (single prompt → subscribe to SSE → exit on idle), and `kilo serve` exposes the API. Headless permission handling is in `packages/opencode/src/kilocode/permission/headless.ts` (subagent asks fail on `kilo run` roots — relevant because a cloud VM has no human to approve). Worktree isolation for parallel local sessions exists in `packages/kilo-vscode/src/agent-manager/WorktreeManager.ts`. There is a background-jobs concept (`GET /kilocode/background-jobs`) in `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`. **There is no VM provisioning, no cloud environment config, and no cloud control plane** — this is greenfield infrastructure.

**Implementation steps.**
1. **Environment definition** — add a `.raya/environment.json` (mirroring Cursor's `.cursor/environment.json`): install/build/start commands, a Dockerfile reference, secret names, and allowed outbound domains. Parse it in a new module under `packages/opencode/src/kilocode/cloud/`.
2. **Provisioner** — a service that, given an environment definition, provisions an isolated VM/container (start with a container runtime — Docker/Firecracker or a managed provider), clones the repo at a ref, installs dependencies from a cached snapshot, injects secrets, and applies egress restrictions. This is a new backend service, not part of `kilo serve`.
3. **Runner inside the VM** — the VM runs `kilo serve` (or `kilo run`) with the auth gateway in front; because there's no human, use the headless permission posture (`packages/opencode/src/kilocode/permission/headless.ts`) plus, if the owner enables it, the global allow-everything primitive (`packages/opencode/src/kilocode/permission/allow-everything.ts`). Surface artifacts (screenshots/recording from `easy.md` feature 4, diffs) for remote verification.
4. **Control plane + API** — endpoints to create/list/stop cloud runs and stream their events back. Model the request/response after the existing Agent Manager orchestration protocol (`packages/opencode/src/kilocode/agent-manager/protocol.ts`) so the surface is consistent. Regenerate the SDK.
5. **Snapshot/caching** — cache the built environment so runs start fast (dependencies pre-installed), matching Cursor's background-build model.

**Acceptance criteria.** A run launched to the cloud provisions an isolated environment, executes against the repo without a local machine involved, restricts egress to the allowlist, and streams events + artifacts back for review; secrets never leak to logs; stopping a run tears down the VM.

**Risk / scope.** This is the single largest item on the list — real infra, security, and cost surface. Prototype with a local container runtime before any managed cloud. The auth gateway (prerequisite) must land first.

---

## 2. Cloud ↔ local session handoff

**Goal.** Move a running session between the local machine and the cloud in either direction — send it up to keep running while offline, pull it down to iterate locally. Source: Cursor Agents Window handoff.

**What already exists.** Sessions are directory-scoped and persisted (SQLite via `Session.create`, `packages/opencode/src/session/session.ts`); the API is already directory-routed via `x-kilo-directory` / `?directory=` (`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`). `kilo run --attach` and `packages/opencode/src/cli/cmd/attach.ts` can connect to a running server. Agent Manager already maps a session to a directory/worktree (`packages/kilo-vscode/src/agent-manager/WorktreeStateManager.ts` `directoryFor`). **Depends on feature 1** (a cloud runner must exist to hand off to).

**Implementation steps.**
1. Define a portable session bundle: session record + message/part history (already in SQLite) + the workspace state (a snapshot hash — reuse `packages/opencode/src/snapshot/`). Add an export/import path under `packages/opencode/src/kilocode/cloud/` that serializes and restores this bundle.
2. Handoff local → cloud: export the bundle, provision a cloud environment (feature 1), import the bundle, and resume via `session.promptAsync` on the cloud runner. Mark the local session as "running in cloud" so the UI reflects it.
3. Handoff cloud → local: pause the cloud run, export the bundle (including any new edits as a snapshot), import locally, and reattach the local client. Reconcile the working tree via the snapshot.
4. UI: a "Move to cloud" / "Bring local" action in the session/Agent Manager surface, mirroring the existing worktree `move` operation in `packages/kilo-vscode/src/agent-manager/orchestration-domain.ts`.

**Acceptance criteria.** A session moved to the cloud continues from the same transcript and workspace state; moved back, the local working tree matches the cloud edits; no message/part loss across the round-trip; only one side is "live" at a time.

**Risk / scope.** Workspace-state reconciliation (edits made on one side arriving on the other) is the hard part — lean entirely on the snapshot system rather than ad-hoc diffing.

---

## 3. Parallel multi-agent orchestration surface

**Goal.** A window that manages many agents across repos at once, showing cloud runs alongside local/worktree runs in one place — extending Raya's Agent Manager to the cloud. Source: Cursor Agents Window.

**What already exists.** This is the most-built-out hard feature: Agent Manager already orchestrates multiple local/worktree sessions. Extension side: `packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts`, `WorktreeManager.ts`, `WorktreeStateManager.ts`, `orchestration-domain.ts` (`overview`, `prompt`, `move`, `answer`), `orchestration-bridge.ts`, and multi-project routing in `project/route.ts`. Webview: `packages/kilo-vscode/webview-ui/agent-manager/`. Backend orchestration protocol already exists: `packages/opencode/src/kilocode/agent-manager/protocol.ts` (`Overview`, `Prompt`, `Stop`, `Move`, `Answer` requests) and `service.ts`, exposed at `/kilocode/agent-manager`. **Depends on feature 1** for the cloud runs it would display.

**Implementation steps.**
1. Extend the orchestration `Overview` protocol (`packages/opencode/src/kilocode/agent-manager/protocol.ts`) to include cloud runs as a run kind alongside local/worktree, with status, location (local/cloud), repo, and branch.
2. Feed cloud-run state (from feature 1's control plane) into the same overview stream the Agent Manager webview already consumes (`webview-ui/agent-manager/project/state.ts` `createProjectStateRouter`), so cloud and local runs render in one list.
3. Add cross-repo grouping — Agent Manager already supports multi-project routing (`project/route.ts`); ensure cloud runs slot into the same project/worktree ref model.
4. Add controls for cloud runs (stop, bring local — feature 2) to the existing action set in `orchestration-domain.ts`.

**Acceptance criteria.** The Agent Manager surface shows local, worktree, and cloud runs together across repos; each shows live status; actions (prompt, stop, move/handoff) work uniformly; the surface updates in real time from the shared event stream.

**Risk / scope.** Mostly additive on top of an existing, well-structured surface — the risk is coupling to feature 1's control plane. Can ship an "empty cloud section" before feature 1 exists.

---

## 4. GitHub-native PR review

**Goal.** Post inline review comments on a pull request (logic issues, security concerns, likely bugs) on request. Source: Copilot Code Review, Cursor Bugbot, Claude Code Action review.

**What already exists.** More than expected. There is a GitHub agent already: `packages/opencode/src/cli/cmd/github.ts` (`GithubCommand`, `GithubInstallCommand`, `GithubRunCommand`) and `packages/opencode/src/cli/cmd/github.handler.ts` (`githubInstall`, `githubRun`) using `@octokit/rest`, `@octokit/graphql`, `@actions/core`, `@actions/github`, and webhook event types. A PR CLI exists: `packages/opencode/src/cli/cmd/pr.ts` (checkout/link/status) with `packages/opencode/src/kilo-sessions/pr-link.ts`. A `/review` command already exists: `packages/opencode/src/kilocode/review/command.ts` (`reviewCommand`, scopes `uncommitted|staged|unpushed|branch|commit|pr`) + `review.txt` template. Security review helper: `packages/opencode/src/kilocode/security/github.ts`. There's a disabled upstream workflow `.github/workflows/disabled/pr-management.yml.disabled` showing the install-and-run-on-PR pattern.

**Implementation steps.**
1. Build a review runner that, given a PR, runs the existing `/review pr` command headlessly (`kilo run --command review` — see the CLI review scope) to produce structured findings (file, line, severity, message).
2. Post findings as inline PR review comments via Octokit in `github.handler.ts` (it already has the Octokit + Actions context) — create a review with `comments[]` anchored to diff positions, not just a summary comment.
3. Trigger paths: (a) a GitHub Action workflow (adapt `.github/workflows/disabled/pr-management.yml.disabled`; remember any new workflow must be added to the allowlist in `script/check-workflows.ts` per AGENTS.md), and (b) an on-demand "Review this PR" action in the extension.
4. Dedupe/update: on re-runs, update the existing review rather than stacking duplicate comments.

**Acceptance criteria.** Requesting a review on a PR produces inline comments anchored to the right lines, categorized by severity; re-running updates rather than duplicates; runs headlessly in CI with a scoped token.

**Risk / scope.** Moderate — most primitives exist (`/review`, Octokit agent). The work is mapping review findings to diff positions and the trigger plumbing. Coordinate with the workflow allowlist guard.

---

## 5. PR autofix

**Goal.** When review finds an issue, spin up an agent that tests a fix and proposes it directly on the PR. Source: Cursor Bugbot Autofix. **Depends on feature 4** (review findings) and benefits from feature 1 (isolated run) or at least worktree isolation.

**What already exists.** Feature 4's review findings; headless execution (`kilo run`); worktree isolation (`WorktreeManager.ts`) for a clean fix branch; the GitHub agent's Octokit context (`github.handler.ts`) for pushing commits/suggestions; and `packages/opencode/src/cli/cmd/pr.ts` for PR checkout.

**Implementation steps.**
1. For a selected review finding, check out the PR branch (or a worktree/cloud env), seed a goal-style run with the finding as the objective (reuse the goal runtime so the completion audit verifies the fix), and let it implement + run the relevant tests.
2. Gate on evidence: only propose the fix if the run reaches a verified-complete state (tests green) — reuse `RayaGoal` completion audit semantics from `packages/opencode/src/kilocode/goal/index.ts`.
3. Propose the fix on the PR: push a commit to a fix branch and open a linked PR, or post a GitHub "suggested change" on the specific lines via Octokit in `github.handler.ts`.
4. Track outcome (proposed / merged) for a merge-rate signal.

**Acceptance criteria.** A review finding can be turned into a tested fix that is proposed on the PR only when tests pass; the fix is scoped to the finding; unverifiable fixes are not proposed.

**Risk / scope.** High — combines autonomous editing, test execution, and write access to a PR. Must run in isolation (worktree at minimum, cloud env ideally) and behind explicit owner opt-in.

---

## 6. Issue → PR background agent

**Goal.** Trigger from `@raya` on a GitHub/Slack/Linear issue or PR, create a branch, implement, and open a PR. Source: Cursor, Copilot coding agent, Claude Code GitHub Action. **Depends on** feature 1 (or worktree isolation) and the auth gateway.

**What already exists.** The GitHub agent already handles webhook events and `@mention`-style triggers: `packages/opencode/src/cli/cmd/github.handler.ts` (`githubRun` consumes GitHub event payloads via `@actions/github`), install flow (`githubInstall`), and the disabled `pr-management.yml.disabled` workflow demonstrates the run-on-event pattern. Headless run: `kilo run`. Branch/worktree: `WorktreeManager.ts`. PR linking: `packages/opencode/src/cli/cmd/pr.ts` + `pr-link.ts`.

**Implementation steps.**
1. Event ingestion: extend `github.handler.ts` to recognize `@raya` mentions on issues/PRs (it already parses GitHub event context). For Slack/Linear, add adapters that translate their events into the same internal "start a task with this objective in this repo" shape.
2. Run: create a branch/worktree (or cloud env), seed a goal run with the issue body as the objective, drive to verified completion.
3. Output: commit, push the branch, and open a PR via Octokit linking back to the originating issue; comment the PR link on the issue.
4. Trigger workflow: a GitHub Action (adapt the disabled workflow; add it to `script/check-workflows.ts` allowlist).

**Acceptance criteria.** Mentioning `@raya` on an issue produces a branch, an implementation verified by the goal audit, and a linked PR, with a comment back on the issue; Slack/Linear triggers reach the same path.

**Risk / scope.** High — autonomous implementation with repo write access from external triggers. Gate behind owner opt-in and the auth gateway; run isolated.

---

## 7. Design ↔ code round-trip

**Goal.** A `/design-sync`-style flow: pull a design system in, hand a finished design off to a build agent, and sync changes back. Source: Claude Design + Claude Code round-trip. **Builds on** the medium-tier "design-system-aware generation loop."

**What already exists.** The medium-tier design-system store and import (`packages/opencode/src/kilocode/design-system/` per `medium.md` feature 5), the `designer` agent + Figma MCP (`get_design_context`, `search_design_system`, `use_figma`) in `packages/opencode/src/kilocode/agent/index.ts` and Chief routing, and the canvas (`packages/kilo-vscode/src/services/canvas/`). Figma export from design tools is generally one-directional (read), so a true round-trip must lean on code as the source of truth.

**Implementation steps.**
1. Add a `/design-sync` command (kilocode command, alongside `packages/opencode/src/kilocode/review/command.ts` as a template) that pulls the current design system (from the medium-tier store) into the working context.
2. Design → code handoff: take a finished design (canvas artifact or Figma node via MCP) and hand it to a build agent (switch to `coder`/`designer`) that generates production code against the stored tokens, verified by the design-system self-correction pass.
3. Code → design sync-back: when code (components/tokens) changes, update the stored design system and, where the MCP supports it, push representative artifacts back (or regenerate the canvas preview). Keep code authoritative to avoid fighting one-directional Figma export.
4. Wire it into the plan/follow-up flow so a design can flow design → build → verify without manual re-prompting.

**Acceptance criteria.** `/design-sync` pulls the design system; a finished design produces code that matches the tokens; code changes update the stored system; the loop runs without re-importing from scratch each time.

**Risk / scope.** Medium-high — depends heavily on MCP capabilities for the design side and on the medium-tier store. Keep the sync-back conservative (code authoritative) until Figma write paths are proven.

---

## 8. Agent SDK + CI runner

**Goal.** Run Raya headlessly inside CI (e.g. GitHub Actions) with scoped allow-tool permissions and cron triggers — a productized, documented way to embed Raya in pipelines. Source: Claude Agent SDK, Claude Code GitHub Actions.

**What already exists.** The building blocks are all present: `kilo run` non-interactive mode (`packages/opencode/src/cli/cmd/run.ts`, supports `--format json`, `--command`, `--continue`, `--session`, `--attach`), headless permission posture (`packages/opencode/src/kilocode/permission/headless.ts`), scoped permission rules (`packages/opencode/src/permission/`), the generated SDK (`packages/sdk/js/`, regen via `./script/generate.ts`), and the GitHub agent (`github.handler.ts`) built on `@actions/core`/`@actions/github`. What's missing is the *productized, documented* surface: a clean SDK entrypoint for external automation and a reusable Action.

**Implementation steps.**
1. **SDK surface** — document and stabilize an external-facing entrypoint (the SDK already exposes `createKiloClient` and `kilo run`); add a thin `@kilocode/sdk`-level helper for "start a run, stream events, get result" so CI/scripts don't hand-roll the SSE loop. Model it on the `kilo run` loop.
2. **Permission scoping for CI** — expose an allow-tool allowlist flag on `kilo run` (map to `Permission.fromConfig` rules) so a CI job grants only the tools it needs; default to the headless deny posture otherwise.
3. **Reusable GitHub Action** — package a Raya Action (adapt `.github/workflows/disabled/pr-management.yml.disabled` and the `githubInstall` flow) that installs the CLI, authenticates, and runs `kilo run`/a command on `@raya` mentions or a cron schedule. Add any new workflow to `script/check-workflows.ts`.
4. **Docs** — a `docs/` guide for embedding Raya in CI (mirroring the existing plan docs' style), covering auth, tool scoping, and cron.

**Acceptance criteria.** A CI job can run Raya headlessly with a scoped tool allowlist, stream/collect results, and be triggered on a schedule or event; the SDK entrypoint is documented; the Action installs and runs without hand-rolled glue.

**Risk / scope.** Lower than features 1–3 (no VM infra) but touches auth, permission scoping, and CI security. The cron piece overlaps with medium feature 2 (scheduled agents) — share the schedule model where possible.
