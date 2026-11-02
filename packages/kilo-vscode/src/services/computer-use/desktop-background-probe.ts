import { DesktopSession } from "./desktop-session"
import { runner, WindowsDesktopDriver } from "./desktop-windows"

type Target = { windowID: string; identity: string }
type Owner = { pid: number; instance: string }

/** Read-only native evidence owned by one background request, never the foreground session. */
export class DesktopBackgroundProbe {
  private readonly owner = runner(10_000)
  private readonly driver = new WindowsDesktopDriver(this.owner)
  private readonly session = new DesktopSession(this.driver)
  private closing: Promise<boolean> | undefined
  private readonly stop = () => this.driver.cancel()

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener("abort", this.stop, { once: true })
    if (signal.aborted) this.stop()
  }

  async verify(target: Target, owner?: Owner): Promise<string> {
    this.ready()
    await this.session.verify(target.windowID, target.identity)
    this.ready()
    const inventory = await this.session.windows(target.windowID)
    this.ready()
    const actual = inventory.windows.find((item) => item.windowID === target.windowID)
    if (!actual || actual.identity !== target.identity)
      throw new Error("Background window was replaced or is no longer available")
    if (owner && (owner.pid !== actual.processID || owner.instance !== actual.processInstance))
      throw new Error("Background window process generation differs from the native grant")
    return inventory.observation.id
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing
    this.signal.removeEventListener("abort", this.stop)
    this.session.dispose()
    this.closing = this.join()
    return this.closing
  }

  private ready() {
    this.signal.throwIfAborted()
    if (this.closing) throw new Error("Background window verifier is closed")
  }

  private join(): Promise<boolean> {
    if (!this.owner.join) return Promise.resolve(false)
    const pending = this.owner.join()
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000)
      pending.then(
        () => {
          clearTimeout(timer)
          resolve(true)
        },
        (err) => {
          clearTimeout(timer)
          console.error("[Raya] Background verifier retirement failed", err)
          resolve(false)
        },
      )
    })
  }
}
