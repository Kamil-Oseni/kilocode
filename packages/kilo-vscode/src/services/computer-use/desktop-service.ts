import * as vscode from "vscode"
import { DesktopPanel } from "./desktop-panel"
import { DesktopSession } from "./desktop-session"
import { WindowsDesktopDriver } from "./desktop-windows"
import { DesktopBridge } from "./desktop-bridge"
import { ComputerUseLeaseStore, type Authorization, type AuthorizationRequest } from "./lease-store"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { WindowsPauseHotkey } from "./windows-pause-hotkey"

export class DesktopAutomationService implements vscode.Disposable {
  private readonly session: DesktopSession | undefined
  private readonly panel: DesktopPanel | undefined
  private readonly bridge: DesktopBridge | undefined
  private readonly lease: ComputerUseLeaseStore | undefined
  private readonly indicator: vscode.StatusBarItem | undefined
  private readonly offLease: (() => void) | undefined
  private hotkey: WindowsPauseHotkey | undefined

  constructor(connection: KiloConnectionService, context: vscode.ExtensionContext, lease?: ComputerUseLeaseStore) {
    if (process.platform !== "win32") return
    this.lease = lease ?? new ComputerUseLeaseStore(context.globalState)
    this.session = new DesktopSession(new WindowsDesktopDriver())
    this.panel = new DesktopPanel(this.session, this.lease)
    this.indicator = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.indicator.name = "Raya desktop control"
    this.indicator.command = "raya.openComputerUse"
    this.offLease = this.lease.onChange((lease) => {
      this.hotkey?.dispose()
      this.hotkey = undefined
      if (!lease) {
        this.bridge?.cancel("Raya desktop control stopped.")
        this.indicator!.hide()
        return
      }
      if (lease.state === "paused") {
        this.bridge?.cancel("Raya desktop control paused.")
      } else {
        this.hotkey = new WindowsPauseHotkey(
          () => this.pause("Raya desktop control paused from the global shortcut."),
          () => {
            if (!lease.cooperativeInput)
              return this.pause("Raya desktop control paused because you began using the computer.")
          },
          () => this.pause("Raya desktop control paused because the global input listener stopped."),
        )
      }
      const label = lease.level === "observe" ? "Observe" : lease.level === "assisted" ? "Assisted" : "Autonomous"
      this.indicator!.text = lease.state === "paused" ? "$(debug-pause) Raya paused" : `$(remote) Raya ${label}`
      this.indicator!.tooltip = "Open Raya desktop controls"
      this.indicator!.backgroundColor =
        lease.state === "paused" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined
      this.indicator!.show()
    })
    this.bridge = new DesktopBridge(
      connection,
      this.session,
      async (request, signal) => {
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
      },
      context.globalState,
      async (request) => this.panel!.authorize(request),
      (request) => this.lease!.authorize(request),
    )
  }

  async show(): Promise<void> {
    if (!this.panel) throw new Error("Raya Computer Use preview currently requires Windows")
    await this.panel.show()
  }

  async authorize(request: AuthorizationRequest): Promise<Authorization> {
    if (!this.panel) return { operation: "authorize", decision: "deny", reason: "Desktop control requires Windows" }
    return this.panel.authorize(request)
  }

  async pause(reason = "Raya desktop control paused from the keyboard."): Promise<void> {
    if (!this.lease || !this.session) return
    await this.lease.pause()
    this.session.takeControl(reason)
  }

  dispose(): void {
    this.hotkey?.dispose()
    this.bridge?.dispose()
    this.panel?.dispose()
    this.session?.dispose()
    this.offLease?.()
    this.indicator?.dispose()
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
