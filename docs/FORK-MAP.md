<!-- raya_change - Phase 3 orientation gate -->

# Raya Fork Map

Last verified against commit `193a0b5e77a85c04d6c443e6a41da6d0489e4480`.

This map identifies the current extension seams in the Kilo fork on which Raya is built. Refresh it after an upstream rebase moves any named symbol or path. No feature milestone in `docs/Building-Raya.md` may begin while this map is missing or stale.

## 1. Tool registry

Tool definitions use `Tool.define(id, init)` in `packages/opencode/src/tool/tool.ts`. The primary built-ins are defined in `packages/opencode/src/tool/read.ts`, `edit.ts`, `shell.ts`, and `task.ts`; the shell tool exposes the model-facing `bash` ID from `packages/opencode/src/tool/shell/id.ts`. The current CLI has no built-in browser tool. Browser capabilities are supplied dynamically through MCP or invoked through shell-based integrations.

The central registry is `packages/opencode/src/tool/registry.ts`. Its service layer initializes each built-in, constructs the `tool` object with `Tool.init`, and places model-visible entries in the `builtin` array passed to `KiloToolRegistry.describe`. `ToolRegistry.tools` then applies provider, permission, feature, and network visibility before returning definitions. `packages/opencode/src/session/tools.ts` converts those definitions and dynamic MCP tools into the callable tool set supplied to the model.

Custom tools are loaded in `tool/registry.ts` from `{tool,tools}/*.{js,ts}` configuration directories and plugin exports. Kilo-owned built-ins are assembled separately through `packages/opencode/src/kilocode/tool/registry.ts`.

Extension seam: define the tool with `Tool.define`, import and initialize it in `packages/opencode/src/tool/registry.ts`, then add it to the `builtin` array near the existing `tool.read`, `tool.edit`, `tool.shell`, and `tool.task` entries. A Kilo-specific tool should instead be added through `KiloToolRegistry.infos`, `build`, and `extra`.

## 2. Session and turn runtime

HTTP prompt requests enter through `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` and call the prompt service in `packages/opencode/src/session/prompt.ts`. The inner `prompt` function accepts and persists the user turn, while `packages/opencode/src/kilocode/session/prompt-queue.ts` provides queued follow-up handling.

The main runtime is `SessionPrompt.runLoop` in `packages/opencode/src/session/prompt.ts`, invoked through `SessionPrompt.loop`. Each iteration marks the session busy, resolves the agent, model, instructions, and tool set, creates a processor, and streams a model step through `SessionProcessor.process`. The processor implementation is `packages/opencode/src/session/processor.ts`; it persists text, reasoning, tool-call lifecycle, snapshots, usage, errors, and step completion.

A turn settles when `runLoop` sees a finished assistant message with no pending tool calls. `packages/opencode/src/session/run-state.ts` owns the runner lifecycle and its `onIdle` callback sets the state through `packages/opencode/src/session/status.ts`. Kilo turn-open and turn-close events are published around `SessionPrompt.loop`, and cancellation enters through `SessionPrompt.cancel`.

Extension seam: inject continuation at the settled return boundary near the end of `SessionPrompt.runLoop`, or enqueue a synthetic/user follow-up through `KiloSessionPromptQueue.enqueue` when continuation must become another normal turn.

## 3. Agent definitions and mode prompts

The agent schema, service, built-in definitions, configuration merge, and default-agent resolution live in `packages/opencode/src/agent/agent.ts`. Native agents include primary and subagent modes; user-defined agents enter through `Config.Info.agent`. Kilo-specific renaming, additional primary modes, permission hardening, and patches are applied in `packages/opencode/src/kilocode/agent/index.ts`, principally through `prepare` and `patchAgents`.

Static agent prompts live under `packages/opencode/src/agent/prompt/`, including `ask.txt`, `debug.txt`, `explore.txt`, `orchestrator.txt`, `summary.txt`, `title.txt`, and `compaction.txt`. Provider-level system prompts are selected in `packages/opencode/src/session/system.ts` from `packages/opencode/src/session/prompt/`.

The active plan-mode prompt is not `packages/opencode/src/session/prompt/plan.txt`. Plan instructions are injected per turn by `KiloSessionPrompt.insertPlanReminders` in `packages/opencode/src/kilocode/session/prompt.ts`, using `packages/opencode/src/kilocode/session/native-plan-prompt.txt`. `packages/opencode/src/session/reminders.ts` calls that injector. Plan exit behavior is implemented by `packages/opencode/src/kilocode/tool/plan.ts` and re-exported from `packages/opencode/src/tool/plan.ts`.

Extension seam: add or alter native agents in `agent/agent.ts`; place Kilo/Raya-specific policy in `kilocode/agent/index.ts`; change active plan behavior through `KiloSessionPrompt.insertPlanReminders` and `native-plan-prompt.txt`.

## 4. Subagent and task tool

The model-facing task tool is `TaskTool` in `packages/opencode/src/tool/task.ts`. Its execute path validates depth and permission, resolves the requested agent, derives child permissions, creates or resumes a child session with `parentID`, selects a model and variant, recursively prompts the child, and returns or injects the result.

Permission ceilings begin in `packages/opencode/src/agent/subagent-permissions.ts` with `deriveSubagentSessionPermission`. Kilo inheritance and merge behavior live in `packages/opencode/src/kilocode/tool/task.ts`: `KiloTask.inherited` carries caller, session, mutation, MCP, and sandbox restrictions; `KiloTask.permissions` applies child-only denies; `KiloTask.merge` combines them. The initial task permission prompt is issued through `ctx.ask` in `TaskTool.execute`.

`KiloTask.resolveModel` in `packages/opencode/src/kilocode/tool/task.ts` owns model and variant precedence. It considers a direct workflow selection, the saved CLI model, the selected agent's model and variant, global `subagent_model` and `subagent_variant`, then the inherited parent model and variant. The resolved choice is passed into the recursive child prompt.

Foreground and background execution both use `BackgroundJob.Service`. Foreground calls wait for completion and render the task result; background calls notify and inject a synthetic result into the parent through the same prompt service. Cost propagation is handled by `packages/opencode/src/kilocode/session/cost-propagation.ts`.

Extension seam: adjust child permission inheritance in `KiloTask.inherited`, model precedence in `KiloTask.resolveModel`, or child-session execution around `TaskTool`'s `sessions.create` and `ops.prompt` calls.

## 5. Local server and generated SDK

The Effect HTTP API is assembled in `packages/opencode/src/server/routes/instance/httpapi/api.ts`. Endpoint contracts are grouped under `packages/opencode/src/server/routes/instance/httpapi/groups/`, while implementations live under the corresponding `handlers/` directory. Session prompt, asynchronous prompt, abort, status, and message routes are declared in `groups/session.ts` and implemented in `handlers/session.ts`.

The event stream is declared in `groups/event.ts` and implemented in `handlers/event.ts`, which exposes the global bus as `text/event-stream`. Server construction and startup are in `packages/opencode/src/server/routes/instance/httpapi/server.ts`.

The repository-level regeneration command is `bun ./script/generate.ts`. It regenerates OpenAPI from the CLI server, writes `packages/sdk/openapi.json`, runs `packages/sdk/js/script/build.ts`, and refreshes generated client code under `packages/sdk/js/src/v2/gen/`.

Extension seam: add an `HttpApiEndpoint` to the appropriate `groups/*.ts`, implement it in `handlers/*.ts`, register any new group in `api.ts`, then run `bun ./script/generate.ts`; never edit `packages/sdk/js/src/gen/` or `src/v2/gen/` manually.

## 6. VS Code webview chat and message channel

The extension activates in `packages/kilo-vscode/src/extension.ts`. `activate` creates the shared `KiloConnectionService`, constructs `KiloProvider`, and registers `KiloProvider.viewType`. Raya's sidebar view ID is `raya.SidebarProvider` in `packages/kilo-vscode/src/KiloProvider.ts` and `packages/kilo-vscode/package.json`. The same connection service is reused by sidebar, editor-tab, settings, and Agent Manager surfaces.

The webview is SolidJS, not React. Its bundle enters at `packages/kilo-vscode/webview-ui/src/index.tsx`; `packages/kilo-vscode/webview-ui/src/App.tsx` creates the root and installs VS Code-specific tool renderers. `packages/kilo-vscode/src/utils.ts` builds the HTML shell, `KiloProvider._getHtmlForWebview` supplies bundle and backend URIs, and `packages/kilo-vscode/esbuild.js` produces `dist/webview.js` and related assets.

Typed webview-to-extension messages are defined by `WebviewMessage` in `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`. Typed extension-to-webview messages are defined by `ExtensionMessage` in `extension-messages.ts`; both are re-exported from the same directory's `index.ts`. `packages/kilo-vscode/webview-ui/src/context/vscode.tsx` wraps `acquireVsCodeApi`, sends messages, and fans out host messages.

`KiloProvider.setupWebviewMessageHandler` is the exact extension-host receive switch. Early messages can be routed through `packages/kilo-vscode/src/kilo-provider/early-message.ts`. In the other direction, `KiloProvider.postMessage` sends state and mapped SSE events. `KiloProvider.handleEvent`, `packages/kilo-vscode/src/kilo-provider-utils.ts`, and `kilo-provider/session-stream-scheduler.ts` convert and coalesce backend events before delivery.

The backend bridge is `packages/kilo-vscode/src/services/cli-backend/connection-service.ts`. It starts or reuses `kilo serve`, creates the generated SDK client, and subscribes through `sdk-sse-adapter.ts`. Prompts travel from `PromptInput.handleSend` in `webview-ui/src/components/chat/PromptInput.tsx`, through `SessionProvider.sendMessage` in `webview-ui/src/context/session.tsx`, to `KiloProvider.handleSendMessage`, which invokes `client.session.promptAsync`.

The webview session store and its main host-message switch are in `webview-ui/src/context/session.tsx`. Transcript layout proceeds through `MessageList.tsx`, `VscodeSessionTurn.tsx`, and `AssistantMessage.tsx`. Generic part and tool dispatch lives in `packages/kilo-ui/src/components/message-part.tsx` through `ToolRegistry.register` and `ToolRegistry.render`; VS Code-specific registrations are installed by `TaskToolExpanded.tsx` and `VscodeToolOverrides.tsx`.

Extension seam: for a new webview-to-host message, add its interface to `webview-messages.ts`, append it to `WebviewMessage`, send it through `useVSCode().postMessage`, and handle it in `KiloProvider.setupWebviewMessageHandler`. For host-to-webview traffic, add the type to `extension-messages.ts`, send it through `KiloProvider.postMessage`, and handle it in `session.tsx` or a dedicated context. Register a new VS Code-only tool renderer through `ToolRegistry.register` from `VscodeToolOverrides.tsx`, called at startup by `App.tsx`.

## Build and packaging anchors

The standalone CLI build script is `packages/opencode/script/build.ts`. On Windows, `bun packages/opencode/script/build.ts --single` produces `packages/opencode/dist/@kilocode/cli-windows-x64/bin/kilo.exe`; the script performs version, model-snapshot, and sandbox-worker smoke checks.

In `packages/kilo-vscode`, `bun run compile` performs development type, lint, and bundle validation. `bun run package` currently performs the production validation build but does not create an archive. The current SHA-stamped VSIX command is `bun run snapshot:build`, implemented by `packages/kilo-vscode/script/dev-snapshot.ts`, and outputs under the system temporary directory's `raya-vscode-snapshots` folder.

## Verified plan drift

- There is no built-in browser tool in `packages/opencode/src/tool/`; browser automation enters through MCP or shell-backed integrations.
- `packages/opencode/src/session/prompt/plan.txt` exists but is not the active Kilo plan-mode prompt. The active file is `packages/opencode/src/kilocode/session/native-plan-prompt.txt`.
- The VS Code webview is SolidJS, despite the React wording in `docs/Building-Raya.md`.
- The current packaged VSIX command is `bun run snapshot:build`; `bun run package` is a production validation build.
