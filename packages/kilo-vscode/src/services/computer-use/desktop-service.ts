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
    this.bridge = new DesktopBridge(connection, this.session, async (request, signal) => {
      const count = request.operation === "watch" ? request.frameCount : 1
      const interval = request.operation === "watch" ? request.intervalMs : 0
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            request.operation === "watch"
              ? "Raya is watching the foreground window"
              : "Raya is looking at the foreground window",
          cancellable: true,
        },
        async (progress, token) => {
          const state = { cancelled: false }
          const stop = token.onCancellationRequested(() => {
            state.cancelled = true
            this.session!.takeControl("You stopped live desktop viewing.")
          })
          try {
            const frames = []
            for (const index of Array.from({ length: count }, (_, value) => value)) {
              if (state.cancelled || signal.aborted) throw new Error("Desktop viewing was stopped")
              frames.push(await this.session!.observe())
              progress.report({ increment: 100 / count, message: `Frame ${index + 1} of ${count}` })
              if (index + 1 < count) await wait(interval, signal, state)
            }
            return frames
          } finally {
            stop.dispose()
          }
        },
      )
    })
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

function wait(ms: number, signal: AbortSignal, state: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const abort = () => done(new Error("Desktop viewing was stopped"))
    function done(error?: Error) {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (error || state.cancelled) return reject(error ?? new Error("Desktop viewing was stopped"))
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted || state.cancelled) abort()
  })
}
