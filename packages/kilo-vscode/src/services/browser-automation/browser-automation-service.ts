// raya_change - Milestone F shared Playwright host and CLI bridge
import { basename, join } from "node:path"
import * as vscode from "vscode"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { BrowserSession } from "./browser-session"
import { BrowserPanel } from "./browser-panel"
import { BrowserBridge } from "./browser-bridge"
import { profile } from "./browser-profile"

type Entry = { session: BrowserSession; panel: BrowserPanel; close: () => void }

export class BrowserAutomationService implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>()
  private readonly bridge: BrowserBridge
  private disposed = false
  private readonly root: string

  constructor(
    private readonly connection: KiloConnectionService,
    context: vscode.ExtensionContext,
  ) {
    this.root = join(context.globalStorageUri.fsPath, "browser-workspaces")
    this.bridge = new BrowserBridge(connection, {
      show: async (directory) => {
        if (!directory) throw new Error("Browser requests require an authoritative workspace directory")
        await (await this.entry(directory)).panel.show(true)
      },
      execute: async (action) => {
        if (!action.origin?.directory) throw new Error("Browser requests require an authoritative workspace directory")
        return (await this.entry(action.origin.directory)).session.execute(action)
      },
      cancel: () => {
        for (const entry of this.entries.values())
          entry.session.takeControl("The agent browser action was paused or cancelled.")
      },
    })
  }

  private async entry(directory: string) {
    this.assertEnabled()
    const owned = await profile(this.root, directory)
    const existing = this.entries.get(owned.owner.profileID)
    if (existing) return existing
    if (this.entries.size >= 4)
      throw new Error(
        "Four workspace browsers are open. Close an unused workspace browser panel before opening another.",
      )
    const session = new BrowserSession(owned.path, undefined, join(owned.path, "artifacts"), owned.owner)
    let closing = false
    const close = () => {
      if (closing) return
      closing = true
      void session.dispose().then(
        () => this.entries.delete(owned.owner.profileID),
        () => {
          closing = false
          console.error("[Raya] Workspace browser closure was not confirmed; retry its profile before continuing.")
        },
      )
    }
    const panel = new BrowserPanel(session, {
      select: () => this.show(false, true),
      close,
    })
    const entry = { session, panel, close }
    this.entries.set(owned.owner.profileID, entry)
    return entry
  }

  async show(preserveFocus = false, choose = false): Promise<void> {
    this.assertEnabled()
    const directories = [
      ...new Set([
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        ...this.connection.getKnownDirectories(),
      ]),
    ]
    if (!directories.length) throw new Error("Open a workspace folder before opening its Raya browser")
    const active =
      vscode.window.activeTextEditor &&
      vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath
    const directory =
      choose || (directories.length > 1 && !active)
        ? (
            await vscode.window.showQuickPick(
              directories.map((directory) => ({ label: basename(directory), description: directory })),
              {
                title: "Choose a workspace browser profile",
                placeHolder: "Each workspace keeps separate sign-in state",
              },
            )
          )?.description
        : (active ?? directories[0])
    if (!directory) return
    await (await this.entry(directory)).panel.show(preserveFocus)
  }

  restore(panel: vscode.WebviewPanel): void {
    // Legacy serialized panels have no authoritative workspace owner. Require a fresh selection.
    panel.dispose()
    void this.show(true).catch(() =>
      vscode.window.showErrorMessage("Choose an open workspace to restore its Raya browser."),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bridge.dispose()
    for (const entry of this.entries.values()) {
      entry.panel.dispose()
      entry.close()
    }
    this.entries.clear()
  }

  private assertEnabled(): void {
    if (this.disposed) throw new Error("Browser service is disposed")
    const enabled = vscode.workspace.getConfiguration("raya.browserAutomation").get<boolean>("enabled", true)
    if (!enabled) throw new Error("Browser automation is disabled in Raya settings")
  }
}
