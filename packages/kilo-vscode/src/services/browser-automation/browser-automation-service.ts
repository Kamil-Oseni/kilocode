// raya_change - Milestone F shared Playwright host and CLI bridge
import { join } from "node:path"
import * as vscode from "vscode"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { BrowserSession } from "./browser-session"
import { BrowserPanel } from "./browser-panel"
import { BrowserBridge } from "./browser-bridge"

export class BrowserAutomationService implements vscode.Disposable {
  readonly panel: BrowserPanel
  readonly session: BrowserSession

  private readonly bridge: BrowserBridge
  private disposed = false

  constructor(connection: KiloConnectionService, context: vscode.ExtensionContext) {
    // raya_change - Milestone G keeps auth state and smoke evidence under extension storage
    this.session = new BrowserSession(
      join(context.globalStorageUri.fsPath, "browser-profile"),
      undefined,
      join(context.globalStorageUri.fsPath, "browser-artifacts"),
    )
    this.panel = new BrowserPanel(this.session)
    this.bridge = new BrowserBridge(connection, {
      show: async () => {
        this.assertEnabled()
        await this.panel.show(true)
      },
      execute: (action) => {
        this.assertEnabled()
        return this.session.execute(action)
      },
      cancel: () => this.session.takeControl("The agent browser action was paused or cancelled."),
    })
  }

  async show(preserveFocus = false): Promise<void> {
    this.assertEnabled()
    await this.panel.show(preserveFocus)
  }

  restore(panel: vscode.WebviewPanel): void {
    this.panel.restore(panel)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bridge.dispose()
    this.panel.dispose()
    void this.session
      .dispose()
      .catch((error: unknown) => console.error("[Kilo New] BrowserAutomationService: disposal failed:", error))
  }

  private assertEnabled(): void {
    const enabled = vscode.workspace.getConfiguration("raya.browserAutomation").get<boolean>("enabled", true)
    if (!enabled) throw new Error("Browser automation is disabled in Raya settings")
  }
}
