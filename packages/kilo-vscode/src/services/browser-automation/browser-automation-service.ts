// raya_change - Milestone F shared Playwright host and CLI bridge
import { join } from "node:path"
import * as vscode from "vscode"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { BrowserSession } from "./browser-session"
import { BrowserPanel } from "./browser-panel"
import { BrowserBridge } from "./browser-bridge"
import { profile } from "./browser-profile"
import type { AdminBrowserSignal } from "../../shared/admin"

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
    this.bridge = new BrowserBridge(
      connection,
      {
        show: async (directory) => {
          if (!directory) throw new Error("Browser requests require an authoritative workspace directory")
          await (await this.entry(directory)).panel.show(true)
        },
        execute: async (action) => {
          if (!action.origin?.directory)
            throw new Error("Browser requests require an authoritative workspace directory")
          return (await this.entry(action.origin.directory)).session.execute(action)
        },
        cancel: () => {
          for (const entry of this.entries.values())
            entry.session.takeControl("The agent browser action was paused or cancelled.")
        },
        uncertain: async (directory, reason) => (await this.entry(directory)).session.interlock(reason),
      },
      context.globalState,
    )
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
    const resume = session.onResume(() => this.bridge.resume(directory))
    let closing = false
    const close = () => {
      if (closing) return
      closing = true
      void session.dispose().then(
        () => {
          resume()
          this.entries.delete(owned.owner.profileID)
        },
        () => {
          closing = false
          console.error("[Raya] Workspace browser closure was not confirmed; retry its profile before continuing.")
        },
      )
    }
    const panel = new BrowserPanel(session, {
      close,
    })
    const entry = { session, panel, close }
    this.entries.set(owned.owner.profileID, entry)
    return entry
  }

  async show(preserveFocus = false): Promise<void> {
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
    const directory = active ?? directories[0]
    await (await this.entry(directory)).panel.show(preserveFocus)
  }

  restore(panel: vscode.WebviewPanel): void {
    // Legacy serialized panels have no authoritative workspace owner. Reopen against the active workspace.
    panel.dispose()
    void this.show(true).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage(`Raya Browser: ${message}`)
    })
  }

  admin(): AdminBrowserSignal {
    if (this.disposed || !vscode.workspace.getConfiguration("raya.browserAutomation").get<boolean>("enabled", true))
      return { status: "unavailable" }
    const states = [...this.entries.values()].map((entry) => entry.session.profileState().status)
    for (const status of ["error", "locked", "auth_expired", "ready", "closed", "unavailable"] as const)
      if (states.includes(status)) return { status }
    return { status: "closed" }
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
