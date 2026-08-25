// raya_change - Raya extension namespace
import * as vscode from "vscode"
import { KiloProvider } from "./KiloProvider"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
import { KiloClawProvider } from "./kiloclaw/KiloClawProvider"
import { DiffViewerProvider } from "./diff/DiffViewerProvider"
import { DocumentViewerProvider } from "./DocumentViewerProvider"
import { DiffSourceCatalog } from "./diff/sources/catalog"
import { DiffVirtualProvider } from "./DiffVirtualProvider"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
import { MarketplacePanelProvider } from "./MarketplacePanelProvider"
import { MarketplaceNotifier } from "./services/marketplace/notifier"
import { SubAgentViewerProvider } from "./SubAgentViewerProvider"
import { EXTENSION_DISPLAY_NAME } from "./constants"
import { KiloConnectionService } from "./services/cli-backend"
import { registerAutocompleteProvider } from "./services/autocomplete"
import { ensureBackendForAutocomplete } from "./services/autocomplete/ensure-backend"
import { AutocompleteServiceManager } from "./services/autocomplete/AutocompleteServiceManager"
import { AttentionService } from "./services/attention"
import { BrowserAutomationService, BrowserPanel } from "./services/browser-automation" // raya_change - Milestone F
import { TelemetryEventName, TelemetryProxy } from "./services/telemetry"
import { registerCommitMessageService } from "./services/commit-message"
import { registerCodeActions, registerTerminalActions, KiloCodeActionProvider } from "./services/code-actions"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"
import { markWorkspace } from "./util/spotlight"
import { createNotebookBridge } from "./services/notebook"
import { createGitExecutable } from "./util/git-executable"
import { isCursorHost } from "./utils"

let agentManager: AgentManagerProvider | undefined
let shuttingDown = false

const RESTORE_KEY = "kilo.workbench.restore"

type RestoreState = {
  agentManager?: boolean
}

const panelTitleHandler = (panel: vscode.WebviewPanel) => (title: string) => {
  panel.title = title || EXTENSION_DISPLAY_NAME
}

// Activated via "onStartupFinished" and "onUri" (package.json) so that commands, code actions,
// keybindings, autocomplete, commit-message generation, and URI deep links all work immediately —
// without requiring the user to open a Kilo sidebar or panel first. The CLI backend is NOT spawned here;
// it starts lazily when a webview connects or when ensureBackendForAutocomplete() triggers it.
export function activate(context: vscode.ExtensionContext) {
  console.log("Kilo Code extension is now active")
  shuttingDown = false

  // Drives the "!raya.isCursor" guards on the native view/title and
  // editor/title menu contributions — see isCursorHost() for why.
  void vscode.commands.executeCommand("setContext", "raya.isCursor", isCursorHost())

  const telemetry = TelemetryProxy.getInstance()

  // Create shared connection service (one server for all webviews)
  const connectionService = new KiloConnectionService(context)
  const notebookBridge = createNotebookBridge(connectionService)
  let restore = context.workspaceState.get<RestoreState>(RESTORE_KEY) ?? {}
  const remember = (patch: RestoreState) => {
    const next = { ...restore, ...patch }
    if (shuttingDown && patch.agentManager === false) next.agentManager = restore.agentManager
    restore = next
    void context.workspaceState.update(RESTORE_KEY, restore)
  }

  // raya_change start - Milestone F shared persistent browser and in-editor panel
  const browserAutomationService = new BrowserAutomationService(connectionService, context)
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.openBrowser", () => browserAutomationService.show(false)),
    vscode.window.registerWebviewPanelSerializer(BrowserPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        browserAutomationService.restore(panel)
        return Promise.resolve()
      },
    }),
  )
  // raya_change end

  // Create remote status service (one status bar item for all webviews)
  const remoteService = new RemoteStatusService()
  context.subscriptions.push(remoteService)
  connectionService.setRemoteService(remoteService)

  // Configure telemetry, set remote service client, and reload autocomplete after backend connection.
  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      const config = connectionService.getServerConfig()
      if (config) {
        telemetry.configure(config.baseUrl, config.password)
        // Sync the CLI's PostHog client with the current consent state. The
        // CLI reads KILO_TELEMETRY_LEVEL once at spawn, so without this call
        // a fresh CLI started while VS Code telemetry was off would stay
        // opted out for the rest of the session.
        telemetry.setEnabled(vscode.env.isTelemetryEnabled)
      }
      try {
        remoteService.setClient(connectionService.getClient())
        console.log("[Kilo New] CLI connected, calling remoteService.refresh()")
        remoteService.refresh().catch((err) => console.warn("[Kilo New] initial remote refresh failed:", err))
      } catch {
        remoteService.setClient(null)
      }
      AutocompleteServiceManager.getInstance()?.load()
    } else {
      remoteService.clearState()
      remoteService.setClient(null)
    }
  })

  // Propagate runtime telemetry consent changes to the CLI subprocess so its
  // PostHog client stays in sync with the user's VS Code telemetry setting.
  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled((enabled) => {
      telemetry.setEnabled(enabled)
    }),
  )

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void markWorkspace(folder.uri.fsPath, (msg) => console.warn(`[Kilo New] ${msg}`))
  }

  // Track all open tab panel providers so toolbar button commands can target them.
  // NOTE: The editor/title toolbar for tab panels intentionally omits Agent Manager
  // and Marketplace buttons (unlike the sidebar). Too many icons causes VS Code to
  // collapse them into a "..." overflow menu, hiding important buttons like Settings.
  const tabPanels = new Map<vscode.WebviewPanel, KiloProvider>()
  const activeTabProvider = () => {
    for (const [panel, p] of tabPanels) {
      if (panel.active) return p
    }
    return undefined
  }

  // Create the provider with shared service
  const provider = new KiloProvider(context.extensionUri, connectionService, context, {
    focusContext: "raya.sidebarFocused",
  })
  provider.setRemoteService(remoteService)

  // Register the webview view provider for the sidebar.
  // retainContextWhenHidden keeps the webview alive when switching to other sidebar panels.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KiloProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Ensure Agent Manager navigation keybindings work when a VS Code terminal has focus.
  // The terminal intercepts all keystrokes unless the command is listed in
  // terminal.integrated.commandsToSkipShell, which only contains built-in
  // commands by default.
  const skip = [
    "raya.agentManagerOpen",
    "raya.agentManager.showTerminal",
    "raya.agentManager.previousTerminal",
    "raya.agentManager.nextTerminal",
  ]
  if (process.platform === "darwin") skip.push("raya.agentManager.runScript")
  ensureCommandsSkipShell(skip)

  // Create KiloClaw chat provider for editor panel
  const kiloClawProvider = new KiloClawProvider(context.extensionUri, connectionService)
  context.subscriptions.push(kiloClawProvider)

  // Create Agent Manager provider for editor panel
  const agentManagerHost = new VscodeHost(context.extensionUri, connectionService, context, remoteService)
  const git = createGitExecutable({
    log: (message) => console.warn(`[Kilo New] ${message}`),
  })
  const agentManagerProvider = new AgentManagerProvider(agentManagerHost, connectionService, git)
  agentManagerProvider.onPanelVisibilityChange((visible) => remember({ agentManager: visible }))
  agentManager = agentManagerProvider
  context.subscriptions.push(agentManagerProvider)

  // Wire "Continue in Worktree" from sidebar → Agent Manager
  provider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )
  provider.setCreateWorktreeHandler((baseBranch, branchName) =>
    agentManagerProvider.createFromSidebar(baseBranch, branchName),
  )

  // Register toggle auto-approve shortcut (Ctrl+Alt+A / Cmd+Alt+A)
  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const autoApprove = registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        const dir =
          provider.getSessionDirectories().get(sessionId) ?? agentManagerProvider.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const dir of provider.getSessionDirectories().values()) dirs.add(dir)
      for (const dir of agentManagerProvider.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )
  const attention = new AttentionService(connectionService, {
    approve: (event, directory) => autoApprove.approve(event, directory),
  })

  // Prewarm only after all global event consumers are ready.
  ensureBackendForAutocomplete(connectionService)

  provider.setAutoApproveController(autoApprove)
  agentManagerHost.setAutoApproveController(autoApprove)

  // Register serializer so Agent Manager restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(AgentManagerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        if (restore.agentManager === false) {
          panel.dispose()
          return Promise.resolve()
        }
        const ctx = agentManagerHost.wrapExistingPanel(panel, {
          onBeforeMessage: (msg) => agentManagerProvider.handleMessage(msg),
          worktreeDirectories: () => agentManagerProvider.getWorktreeDirectories(),
          workspaceRoot: () => agentManagerProvider.workspaceRoot(),
          projectId: () => agentManagerProvider.projectId(),
        })
        agentManagerProvider.deserializePanel(ctx)
        return Promise.resolve()
      },
    }),
  )

  // Register serializer so KiloClaw panel restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(KiloClawProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        kiloClawProvider.restorePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  // Register serializer so "Open in Tab" restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("raya.TabPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
          tabTitle: panelTitleHandler(panel),
          topBarSurface: "tab",
        })
        tabProvider.setRemoteService(remoteService)
        tabProvider.setAutoApproveController(autoApprove)
        tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
          agentManagerProvider.continueFromSidebar(sessionId, progress),
        )
        tabProvider.setCreateWorktreeHandler((baseBranch, branchName) =>
          agentManagerProvider.createFromSidebar(baseBranch, branchName),
        )
        tabProvider.setDiffVirtualProvider(diffVirtualProvider)
        tabProvider.resolveWebviewPanel(panel)
        tabPanels.set(panel, tabProvider)
        panel.onDidDispose(
          () => {
            console.log("[Kilo New] Tab panel restored from restart disposed")
            tabPanels.delete(panel)
            tabProvider.dispose()
          },
          null,
          context.subscriptions,
        )
        return Promise.resolve()
      },
    }),
  )

  const diffSourceCatalog = new DiffSourceCatalog(connectionService)
  context.subscriptions.push(diffSourceCatalog)
  const diffViewerProvider = new DiffViewerProvider(context.extensionUri, connectionService, diffSourceCatalog, {
    sessionIdProvider: () => provider.getCurrentSessionId(),
    sessionDirectoryProvider: (sessionId) => provider.getSessionGitDirectory(sessionId),
  })
  diffViewerProvider.setCommentHandler((comments, autoSend) => {
    void provider.appendReviewComments(comments, autoSend)
  })
  provider.setDiffViewerProvider(diffViewerProvider)
  context.subscriptions.push(diffViewerProvider)

  const documentViewerProvider = new DocumentViewerProvider(context.extensionUri, connectionService, {
    onComments: (comments, autoSend) => void provider.appendReviewComments(comments, autoSend),
  })
  provider.setDocumentViewerProvider(documentViewerProvider)
  context.subscriptions.push(documentViewerProvider)

  // Create diff virtual provider (lightweight single-file diff for permission approval)
  const diffVirtualProvider = new DiffVirtualProvider(context.extensionUri)
  provider.setDiffVirtualProvider(diffVirtualProvider)
  agentManagerHost.setDiffVirtualProvider(diffVirtualProvider)
  context.subscriptions.push(diffVirtualProvider)

  // Create standalone editor providers (open in editor area, not sidebar)
  const settingsEditorProvider = new SettingsEditorProvider(context.extensionUri, connectionService, context, {
    ...agentManagerProvider.settings,
  })
  settingsEditorProvider.setRemoteService(remoteService)
  const marketplacePanelProvider = new MarketplacePanelProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(settingsEditorProvider, marketplacePanelProvider)

  // Surface a discardable notification when a marketplace item matches the workspace.
  const marketplaceNotifier = new MarketplaceNotifier(connectionService, context, (item) =>
    marketplacePanelProvider.openInstall(item),
  )
  context.subscriptions.push(marketplaceNotifier)
  marketplaceNotifier.start()

  // Create sub-agent viewer provider (read-only editor panel for sub-agent sessions)
  const subAgentViewerProvider = new SubAgentViewerProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(subAgentViewerProvider)

  // Register serializers so standalone panels restore on restart
  const settingsViews = ["settingsPanel", "profilePanel"] as const
  for (const suffix of settingsViews) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(`raya.${suffix}`, {
        deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          settingsEditorProvider.deserializePanel(panel)
          return Promise.resolve()
        },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(MarketplacePanelProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        marketplacePanelProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DocumentViewerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DiffViewerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        diffViewerProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("raya.SubAgentViewerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        // Sub-agent viewer requires a session ID that can't be recovered
        // after restart, so dispose the stale panel cleanly.
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  // Sidebar menus use wrapper commands so this event measures real title button presses,
  // not programmatic opens, shortcuts, or editor title commands.
  const track = (button: string, command: string) => {
    TelemetryProxy.capture(TelemetryEventName.TITLE_BUTTON_CLICKED, {
      button,
      surface: "sidebar_title",
    })
    void vscode.commands.executeCommand(command)
  }

  // Register toolbar button command handlers
  context.subscriptions.push(
    vscode.commands.registerCommand("raya.sidebarTitle.plusButtonClicked", () => {
      track("new_task", "raya.plusButtonClicked")
    }),
    vscode.commands.registerCommand("raya.sidebarTitle.historyButtonClicked", () => {
      track("history", "raya.historyButtonClicked")
    }),
    vscode.commands.registerCommand("raya.sidebarTitle.agentManagerOpen", () => {
      track("agent_manager", "raya.agentManagerOpen")
    }),
    vscode.commands.registerCommand("raya.sidebarTitle.kiloClawOpen", () => {
      track("kiloclaw", "raya.kiloClawOpen")
    }),
    vscode.commands.registerCommand("raya.sidebarTitle.marketplaceButtonClicked", () => {
      track("marketplace", "raya.marketplaceButtonClicked")
    }),
    vscode.commands.registerCommand("raya.sidebarTitle.profileButtonClicked", () => {
      track("profile", "raya.profileButtonClicked")
    }),
    vscode.commands.registerCommand("raya.sidebarTitle.settingsButtonClicked", () => {
      track("settings", "raya.settingsButtonClicked")
    }),
    vscode.commands.registerCommand("raya.plusButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "plusButtonClicked" })
      else provider.postMessage({ type: "action", action: "plusButtonClicked" })
    }),
    vscode.commands.registerCommand("raya.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
    }),
    vscode.commands.registerCommand("raya.marketplaceButtonClicked", (directory?: string | null) => {
      marketplacePanelProvider.openPanel(directory)
    }),
    vscode.commands.registerCommand("raya.kiloClawOpen", () => {
      kiloClawProvider.openPanel()
    }),
    vscode.commands.registerCommand("raya.historyButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "historyButtonClicked" })
      else provider.postMessage({ type: "action", action: "historyButtonClicked" })
    }),
    vscode.commands.registerCommand("raya.cycleAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cycleAgentMode" })
      else provider.postMessage({ type: "action", action: "cycleAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cycleAgentMode" })
    }),
    vscode.commands.registerCommand("raya.cyclePreviousAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      else provider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
    }),
    vscode.commands.registerCommand("raya.profileButtonClicked", () => {
      settingsEditorProvider.openPanel("profile")
    }),
    vscode.commands.registerCommand("raya.settingsButtonClicked", (tab?: string, projectId?: string) => {
      settingsEditorProvider.openPanel("settings", tab, projectId)
    }),
    vscode.commands.registerCommand("raya.openIndexingSettings", () => {
      settingsEditorProvider.openPanel("settings", "indexing")
    }),
    vscode.commands.registerCommand("raya.showMemory", async () => {
      if (agentManagerProvider.isActive()) {
        await agentManagerProvider.showMemory()
        return
      }
      const target = activeTabProvider() ?? provider
      if (target === provider) await vscode.commands.executeCommand("raya.SidebarProvider.focus")
      await target.waitForReady()
      await target.showMemory()
    }),
    vscode.commands.registerCommand("raya.toggleMemory", async () => {
      if (agentManagerProvider.isActive()) {
        await agentManagerProvider.toggleMemory()
        return
      }
      const target = activeTabProvider() ?? provider
      if (target === provider) await vscode.commands.executeCommand("raya.SidebarProvider.focus")
      await target.waitForReady()
      await target.toggleMemory()
    }),
    // legacy-migration start
    vscode.commands.registerCommand("raya.openMigrationWizard", () => {
      provider.postMessage({ type: "migrationState", needed: true, source: "legacy" })
    }),
    // legacy-migration end
    vscode.commands.registerCommand("raya.generateTerminalCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Describe the terminal command you want to generate",
        placeHolder: "e.g., find all .ts files modified in the last 24 hours",
      })
      if (!input) return
      await vscode.commands.executeCommand("raya.SidebarProvider.focus")
      await provider.waitForReady()
      provider.postMessage({ type: "triggerTask", text: `Generate a terminal command: ${input}` })
    }),
    vscode.commands.registerCommand("raya.toggleRemote", () => {
      remoteService.toggle().catch((err) => console.error("[Kilo New] toggleRemote command failed:", err))
    }),
    vscode.commands.registerCommand("raya.openInTab", () => {
      return openKiloInNewTab(
        context,
        connectionService,
        agentManagerProvider,
        tabPanels,
        diffVirtualProvider,
        remoteService,
        autoApprove,
      )
    }),
    vscode.commands.registerCommand(
      "raya.showChanges",
      (arg?: { sessionId?: string; turnId?: string; initialSourceId?: string; directory?: string }) => {
        diffViewerProvider.openFromCommand(arg)
      },
    ),
    vscode.commands.registerCommand(
      "raya.openSubAgentViewer",
      (sessionID: string, title?: string, directory?: string) => {
        subAgentViewerProvider.openPanel(sessionID, title, directory)
      },
    ),
    vscode.commands.registerCommand("raya.agentManager.previousSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionPrevious" })
    }),
    vscode.commands.registerCommand("raya.agentManager.nextSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionNext" })
    }),
    vscode.commands.registerCommand("raya.agentManager.previousTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabPrevious" })
    }),
    vscode.commands.registerCommand("raya.agentManager.nextTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabNext" })
    }),
    vscode.commands.registerCommand("raya.agentManager.previousTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "terminalPrevious" })
    }),
    vscode.commands.registerCommand("raya.agentManager.nextTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "terminalNext" })
    }),
    vscode.commands.registerCommand("raya.agentManager.search", () => {
      agentManagerProvider.postMessage({ type: "action", action: "search" })
    }),
    vscode.commands.registerCommand("raya.agentManager.showTerminal", () => {
      // Route through the webview so it can reach into the active session
      // state and open the VS Code integrated terminal for it.
      agentManagerProvider.postMessage({ type: "action", action: "showTerminal" })
    }),
    vscode.commands.registerCommand("raya.agentManager.runScript", () => {
      agentManagerProvider.postMessage({ type: "action", action: "runScript" })
    }),
    vscode.commands.registerCommand("raya.agentManager.toggleDiff", () => {
      agentManagerProvider.postMessage({ type: "action", action: "toggleDiff" })
    }),
    vscode.commands.registerCommand("raya.agentManager.showShortcuts", () => {
      agentManagerProvider.postMessage({ type: "action", action: "showShortcuts" })
    }),

    vscode.commands.registerCommand("raya.agentManager.newTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("raya.agentManager.newTerminalTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTerminalTab" })
    }),
    vscode.commands.registerCommand("raya.agentManager.newSideTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newSideTerminal" })
    }),
    vscode.commands.registerCommand("raya.agentManager.closeTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeTab" })
    }),
    vscode.commands.registerCommand("raya.agentManager.newWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newWorktree" })
    }),
    vscode.commands.registerCommand("raya.agentManager.quickWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "quickWorktree" })
    }),
    vscode.commands.registerCommand("raya.agentManager.openWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "openWorktree" })
    }),
    vscode.commands.registerCommand("raya.agentManager.openPR", () => {
      agentManagerProvider.postMessage({ type: "action", action: "openPR" })
    }),
    vscode.commands.registerCommand("raya.agentManager.closeWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeWorktree" })
    }),
    vscode.commands.registerCommand("raya.agentManager.advancedWorktree", () =>
      agentManagerProvider.openAdvancedWorktree(),
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`raya.agentManager.jumpTo${i + 1}`, () => {
        agentManagerProvider.postMessage({ type: "action", action: `jumpTo${i + 1}` })
      }),
    ),
  )

  // Register URI handler for extension deep links (vscode://eden.raya/raya/...)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const sessionMatch = uri.path.match(/^\/raya\/s\/([a-zA-Z0-9_-]+)$/)
        const sessionId = sessionMatch?.[1]
        if (sessionId) {
          console.log("[Kilo New] URI handler: opening cloud session:", sessionId)
          await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
          provider.openCloudSession(sessionId)
          return
        }

        if (uri.path !== "/raya/switch" && uri.path !== "/raya/model") return
        const params = new URLSearchParams(uri.query)
        const modelID = params.get("model") || undefined
        const agent = params.get("agent") || undefined
        if (!modelID && !agent) return
        console.log("[Kilo New] URI handler: applying linked Kilo selection:", { modelID, agent })
        await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
        provider.selectKiloModel(modelID, agent)
      },
    }),
  )

  // Register autocomplete provider
  void registerAutocompleteProvider(context, connectionService)

  // Register commit message generation
  registerCommitMessageService(context, connectionService)

  registerHeapSnapshot(context, connectionService)

  context.subscriptions.push(
    vscode.commands.registerCommand("raya.reload", () => {
      provider.reload().catch((e) => console.error("[Kilo New] reload command failed:", e))
    }),
  )

  // Register code actions (editor context menus, terminal context menus, keyboard shortcuts)
  registerCodeActions(context, provider, agentManagerProvider, activeTabProvider)
  registerTerminalActions(context, provider, agentManagerProvider)

  // Register CodeActionProvider (lightbulb quick fixes)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  // Dispose services when extension deactivates (kills the server)
  context.subscriptions.push({
    dispose: () => {
      shuttingDown = true
      unsubscribeStateChange()
      attention.dispose()
      browserAutomationService.dispose()
      provider.dispose()
      notebookBridge.dispose()
      connectionService.dispose()
    },
  })
}

export async function deactivate() {
  shuttingDown = true
  await agentManager?.shutdown()
  TelemetryProxy.getInstance().shutdown()
}

function openKiloInNewTab(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  agentManagerProvider: AgentManagerProvider,
  tabPanels: Map<vscode.WebviewPanel, KiloProvider>,
  diffVirtualProvider: DiffVirtualProvider,
  remoteService: RemoteStatusService,
  autoApprove: ReturnType<typeof registerToggleAutoApprove>,
) {
  const panel = vscode.window.createWebviewPanel("raya.TabPanel", EXTENSION_DISPLAY_NAME, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  })

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-light.svg"),
    dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-dark.svg"),
  }

  const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
    tabTitle: panelTitleHandler(panel),
    topBarSurface: "tab",
  })
  tabProvider.setRemoteService(remoteService)
  tabProvider.setAutoApproveController(autoApprove)
  tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )
  tabProvider.setCreateWorktreeHandler((baseBranch, branchName) =>
    agentManagerProvider.createFromSidebar(baseBranch, branchName),
  )
  tabProvider.setDiffVirtualProvider(diffVirtualProvider)
  tabProvider.resolveWebviewPanel(panel)
  tabPanels.set(panel, tabProvider)

  panel.onDidDispose(
    () => {
      console.log("[Kilo New] Tab panel disposed")
      tabPanels.delete(panel)
      tabProvider.dispose()
    },
    null,
    context.subscriptions,
  )
}

/**
 * Add extension commands to terminal.integrated.commandsToSkipShell so they
 * work when a VS Code terminal has focus. The setting only ships with built-in
 * commands; extension commands must be added explicitly.
 */
function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  // Update whichever scope already carries an override so we don't
  // shadow workspace settings or leak workspace values into global.
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}
