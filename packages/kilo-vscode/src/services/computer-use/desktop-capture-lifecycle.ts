type Connection = {
  getConnectionState(): string
  onStateChange(listener: (state: string) => void): () => void
}

type Lease = {
  current():
    | {
        state: "active" | "paused" | "revoked"
        applications: { kind: "all" | "selected" }
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
  startCapture(failed: (error: unknown) => void): void
  stopCapture(): void
}

export class DesktopCaptureLifecycle {
  private readonly off: Array<() => void>
  private connected: boolean

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
      lease.applications.kind === "all" &&
      lease.monitors.kind === "all" &&
      lease.surfaces.includes("desktop") &&
      lease.actions.includes("observe") &&
      this.session.current().control === "agent"
    ) {
      this.driver.startCapture(this.failed)
      return
    }
    this.driver.stopCapture()
  }
}
