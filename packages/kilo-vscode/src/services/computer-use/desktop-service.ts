import * as vscode from "vscode"
import { DesktopPanel } from "./desktop-panel"
import { DesktopSession } from "./desktop-session"
import { WindowsDesktopDriver } from "./desktop-windows"
import { DesktopBridge } from "./desktop-bridge"
import type { KiloConnectionService } from "../cli-backend/connection-service"

export class DesktopAutomationService implements vscode.Disposable {
  private readonly session: DesktopSession | undefined
  private readonly panel: DesktopPanel | undefined
  private readonly bridge: DesktopBridge | undefined

  constructor(connection: KiloConnectionService) {
    if (process.platform !== "win32") return
    this.session = new DesktopSession(new WindowsDesktopDriver())
    this.panel = new DesktopPanel(this.session)
    this.bridge = new DesktopBridge(connection, this.session, async () =>
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Raya is looking at the foreground window",
          cancellable: false,
        },
        () => this.session!.observe(),
      ),
    )
  }

  async show(): Promise<void> {
    if (!this.panel) throw new Error("Raya Computer Use preview currently requires Windows")
    await this.panel.show()
  }

  dispose(): void {
    this.bridge?.dispose()
    this.panel?.dispose()
    this.session?.dispose()
  }
}
