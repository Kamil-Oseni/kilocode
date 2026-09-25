type Connection = {
  getConnectionState(): string
  onStateChange(listener: (state: string) => void): () => void
}

type Lease = {
  current():
    | {
        id: string
        state: "active" | "paused" | "revoked"
        applications: { kind: "all" } | { kind: "selected"; values: string[]; identity?: string }
        monitors: { kind: "all" | "selected" }
        surfaces: readonly string[]
        actions: readonly string[]
      }
    | undefined
  onChange(listener: () => void): () => void
}

type Session = {
  current(): { control: "agent" | "manual" }
  onState(listener: () => void): () => void
}

type Driver = {
  startCapture(failed: (error: unknown) => void, target?: { windowID: string; identity: string }): void
  stopCapture(): void
}

export class DesktopCaptureLifecycle {
  private readonly off: Array<() => void>
  private connected: boolean
  private scope: string | undefined

  constructor(
    private readonly lease: Lease,
    private readonly session: Session,
    private readonly driver: Driver,
    connection: Connection,
    private readonly failed: (error: unknown) => void,
    private readonly ready: () => boolean = () => true,
  ) {
    this.connected = connection.getConnectionState() === "connected"
    this.off = [
      lease.onChange(() => this.sync()),
      session.onState(() => this.sync()),
      connection.onStateChange((state) => {
        this.connected = state === "connected"
        this.sync()
      }),
    ]
    this.sync()
  }

  dispose(): void {
    for (const off of this.off) off()
    this.scope = undefined
    this.driver.stopCapture()
  }

  refresh(): void {
    this.sync()
  }

  private sync(): void {
    const lease = this.lease.current()
    if (
      this.connected &&
      this.ready() &&
      lease?.state === "active" &&
      lease.monitors.kind === "all" &&
      lease.surfaces.includes("desktop") &&
      lease.actions.includes("observe") &&
      this.session.current().control === "agent"
    ) {
      const target =
        lease.applications.kind === "selected" &&
        lease.applications.values.length === 1 &&
        /^0x[0-9A-F]+$/.test(lease.applications.values[0]!) &&
        /^[0-9A-F]{64}$/.test(lease.applications.identity ?? "")
          ? { windowID: lease.applications.values[0]!, identity: lease.applications.identity! }
          : undefined
      if (lease.applications.kind === "selected" && !target) {
        this.scope = undefined
        this.driver.stopCapture()
        return
      }
      const scope = JSON.stringify([lease.id, target])
      if (this.scope !== scope) this.driver.stopCapture()
      this.scope = scope
      this.driver.startCapture(this.failed, target)
      return
    }
    this.scope = undefined
    this.driver.stopCapture()
  }
}
