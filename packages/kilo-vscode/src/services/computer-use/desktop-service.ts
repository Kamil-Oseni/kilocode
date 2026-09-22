import * as vscode from "vscode"
import { DesktopPanel } from "./desktop-panel"
import { DesktopSession } from "./desktop-session"
import { WindowsDesktopDriver } from "./desktop-windows"

export class DesktopAutomationService implements vscode.Disposable {
  private readonly session: DesktopSession | undefined
  private readonly panel: DesktopPanel | undefined

  constructor() {
    if (process.platform !== "win32") return
    this.session = new DesktopSession(new WindowsDesktopDriver())
    this.panel = new DesktopPanel(this.session)
  }

  async show(): Promise<void> {
    if (!this.panel) throw new Error("Raya Computer Use preview currently requires Windows")
    await this.panel.show()
  }

  dispose(): void {
    this.panel?.dispose()
    this.session?.dispose()
  }
}
