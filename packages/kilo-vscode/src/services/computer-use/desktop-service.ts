import * as vscode from "vscode"
import { join } from "node:path"
import { DesktopPanel } from "./desktop-panel"
import { DesktopSession } from "./desktop-session"
import { WindowsDesktopDriver } from "./desktop-windows"
import { DesktopBridge } from "./desktop-bridge"
import { ComputerUseLeaseStore, type Authorization, type AuthorizationRequest } from "./lease-store"
import type { KiloConnectionService } from "../cli-backend/connection-service"
import { WindowsPauseHotkey } from "./windows-pause-hotkey"
import { bounded, changed, DesktopCadence, limit, WATCH } from "./desktop-cadence"
import { DesktopCaptureLifecycle } from "./desktop-capture-lifecycle"

export class DesktopAutomationService implements vscode.Disposable {
  private readonly driver: WindowsDesktopDriver | undefined
  private readonly session: DesktopSession | undefined
  private readonly panel: DesktopPanel | undefined
  private readonly bridge: DesktopBridge | undefined
  private readonly lease: ComputerUseLeaseStore | undefined
  private readonly indicator: vscode.StatusBarItem | undefined
  private readonly offLease: (() => void) | undefined
  private readonly offConnection: (() => void) | undefined
  private readonly capture: DesktopCaptureLifecycle | undefined
  private hotkey: WindowsPauseHotkey | undefined

  constructor(connection: KiloConnectionService, context: vscode.ExtensionContext, lease: ComputerUseLeaseStore) {
    if (process.platform !== "win32") return
    this.lease = lease
    const binary =
      process.env.RAYA_NATIVE_CAPTURE_CANDIDATE === "1"
        ? join(context.extensionPath, "bin", "raya-desktop-capture.exe")
        : undefined
    this.driver = new WindowsDesktopDriver(
      undefined,
      undefined,
      binary,
      [],
      binary ? join(context.globalStorageUri.fsPath, "desktop-capture-faults") : undefined,
    )
    this.session = new DesktopSession(this.driver)
    this.panel = new DesktopPanel(this.session, this.lease, () => this.ready())
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
        void this.hotkey.ready().then(() => this.capture?.refresh())
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
        if (request.operation === "watch" && !bounded(count, interval))
          throw new Error("Desktop watch exceeds the ten-second local capture budget")
        const capture = async (
          progress?: vscode.Progress<{ increment?: number; message?: string }>,
          token?: vscode.CancellationToken,
        ) => {
          const state = { cancelled: false }
          const stop = token?.onCancellationRequested(() => {
            state.cancelled = true
            this.session!.takeControl("You stopped live desktop viewing.")
          })
          try {
            const frames = []
            const cadence = request.operation === "watch" ? new DesktopCadence(interval) : undefined
            const deadline = performance.now() + WATCH.budget
            let previous: Awaited<ReturnType<DesktopSession["observe"]>> | undefined
            for (const index of Array.from({ length: count }, (_, value) => value)) {
              if (state.cancelled || signal.aborted) throw new Error("Desktop viewing was stopped")
              const capture = this.session!.observe()
              const frame =
                request.operation === "watch"
                  ? await limit(capture, deadline - performance.now(), () =>
                      this.pause("Raya desktop control paused because a bounded watch exceeded ten seconds."),
                    )
                  : await capture
              frames.push(frame)
              progress?.report({ increment: 100 / count, message: `Frame ${index + 1} of ${count}` })
              if (index + 1 < count)
                await wait(
                  Math.min(cadence!.next(changed(previous, frame)), Math.max(0, deadline - performance.now())),
                  signal,
                  state,
                )
              previous = frame
            }
            return frames
          } finally {
            stop?.dispose()
          }
        }
        const lease = this.lease?.current()
        if (lease?.state === "active" && lease.level === "autonomous") return capture()
        return vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
              request.operation === "watch"
                ? "Raya is watching the foreground window"
                : "Raya is looking at the foreground window",
            cancellable: true,
          },
          capture,
        )
      },
      context.globalState,
      async (request) => this.authorize(request),
      (request) =>
        this.hotkey?.isReady
          ? this.lease!.authorize(request)
          : { operation: "authorize", decision: "deny", reason: "The global Pause Raya shortcut is not ready" },
    )
    this.capture = new DesktopCaptureLifecycle(
      this.lease,
      this.session,
      this.driver,
      connection,
      () => {
        void this.pause("Raya desktop control paused because continuous capture stopped unexpectedly.").catch((error) =>
          console.error("[Raya] Failed to persist desktop pause after capture loss", error),
        )
      },
      () => !!this.hotkey?.isReady,
    )
    this.offConnection = connection.onStateChange((state) => {
      if (state === "disconnected" || state === "error")
        void this.pause("Raya desktop control paused because the backend disconnected.").catch((error) =>
          console.error("[Raya] Failed to persist desktop pause after disconnect", error),
        )
    })
  }

  async show(): Promise<void> {
    if (!this.panel) throw new Error("Raya Computer Use preview currently requires Windows")
    await this.panel.show()
  }

  /** Host-local diagnostics only; no backend request or desktop action. */
  journalEvidence() {
    return {
      state: this.bridge?.journalState() ?? ("unavailable" as const),
      summary: this.bridge?.journalSummary() ?? null,
    }
  }

  async authorize(request: AuthorizationRequest): Promise<Authorization> {
    if (!this.panel) return { operation: "authorize", decision: "deny", reason: "Desktop control requires Windows" }
    if (request.surface === "desktop" && !this.lease?.current() && this.lease?.authorize(request).decision === "ask") {
      try {
        await this.driver!.warmup()
      } catch (error) {
        if (!this.lease?.current()) this.driver?.cancel()
        return {
          operation: "authorize",
          decision: "deny",
          reason: `Windows desktop host could not start: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    const result = await this.panel.authorize(request)
    if (result.decision !== "allow") {
      if (!this.lease?.current()) this.driver?.cancel()
      return result
    }
    if (await this.ready()) return result
    return { operation: "authorize", decision: "deny", reason: "The global Pause Raya shortcut is not ready" }
  }

  private async ready(): Promise<boolean> {
    const hotkey = this.hotkey
    if (!hotkey || !(await hotkey.ready())) return false
    return this.hotkey === hotkey && !!hotkey.isReady && this.lease?.current()?.state === "active"
  }

  async pause(reason = "Raya desktop control paused from the keyboard."): Promise<void> {
    if (!this.lease || !this.session) return
    this.session.takeControl(reason)
    await this.lease.pause()
  }

  dispose(): void {
    this.capture?.dispose()
    this.hotkey?.dispose()
    this.bridge?.dispose()
    this.panel?.dispose()
    this.session?.dispose()
    this.offLease?.()
    this.offConnection?.()
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
