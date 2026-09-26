type Connection = {
  getConnectionState(): string
  onStateChange(listener: (state: string) => void): () => void
}

type Lease = {
  current():
    | {
        id: string
        state: "active" | "paused" | "revoked"
        applications:
          | { kind: "all" }
          | { kind: "selected"; values: string[]; identities?: Record<string, string>; identity?: string }
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
  probeCurrent?(): Promise<{ windowID: string }>
  probePinCurrent?(windowID: string): Promise<{ windowID: string; identity: string }>
  cancelProbe?(): void
}

const cadence = 250

export class DesktopCaptureLifecycle {
  private readonly off: Array<() => void>
  private connected: boolean
  private scope: string | undefined
  private selection: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private revision = 0
  private fault: string | undefined

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
    this.cancelPoll()
    this.scope = undefined
    this.driver.stopCapture()
  }

  refresh(): void {
    this.sync()
  }

  private sync(): void {
    const lease = this.lease.current()
    if (this.blocked(lease)) {
      this.cancelPoll()
      this.scope = undefined
      this.driver.stopCapture()
      return
    }
    if (!lease || !this.enabled(lease)) {
      this.cancelPoll()
      this.scope = undefined
      this.driver.stopCapture()
      return
    }
    if (lease.applications.kind === "selected" && lease.applications.values.length > 1) {
      this.selected(lease.id, lease.applications.values, lease.applications.identities)
      return
    }
    this.cancelPoll()
    const target =
      lease.applications.kind === "selected" &&
      lease.applications.values.length === 1 &&
      /^0x[0-9A-F]+$/.test(lease.applications.values[0]!) &&
      /^[0-9A-F]{64}$/.test(
        lease.applications.identity ?? lease.applications.identities?.[lease.applications.values[0]!] ?? "",
      )
        ? {
            windowID: lease.applications.values[0]!,
            identity: (lease.applications.identity ?? lease.applications.identities?.[lease.applications.values[0]!])!,
          }
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
  }

  private blocked(lease: ReturnType<Lease["current"]>): boolean {
    if (this.fault && (!lease || lease.id !== this.fault || lease.state !== "active")) this.fault = undefined
    return !!this.fault
  }

  private enabled(lease: NonNullable<ReturnType<Lease["current"]>>): boolean {
    return (
      this.connected &&
      this.ready() &&
      lease.state === "active" &&
      lease.monitors.kind === "all" &&
      lease.surfaces.includes("desktop") &&
      lease.actions.includes("observe") &&
      this.session.current().control === "agent"
    )
  }

  private selected(id: string, values: string[], identities?: Record<string, string>): void {
    if (
      !this.driver.probeCurrent ||
      !this.driver.probePinCurrent ||
      !this.driver.cancelProbe ||
      values.length > 64 ||
      new Set(values).size !== values.length ||
      values.some((window) => !/^0x[0-9A-F]+$/.test(window) || !/^[0-9A-F]{64}$/.test(identities?.[window] ?? ""))
    ) {
      this.cancelPoll()
      this.scope = undefined
      this.driver.stopCapture()
      return
    }
    const selection = JSON.stringify([id, values, identities])
    if (selection === this.selection) return
    this.cancelPoll()
    this.driver.stopCapture()
    this.scope = undefined
    this.selection = selection
    void this.poll(id, new Map(values.map((window) => [window, identities![window]!])), this.revision)
  }

  private cancelPoll(): void {
    this.revision += 1
    this.selection = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.driver.cancelProbe?.()
  }

  private async poll(id: string, windows: Map<string, string>, revision: number): Promise<void> {
    const current = await this.driver.probeCurrent!().catch((error: unknown) => {
      if (revision === this.revision) this.lost(error)
      return undefined
    })
    if (revision !== this.revision || !current) return
    const identity = windows.get(current.windowID)
    const pinned = identity
      ? await this.driver.probePinCurrent!(current.windowID).catch(async (error: unknown) => {
          const latest = await this.driver.probeCurrent!().catch(() => undefined)
          if (revision === this.revision && (!latest || latest.windowID === current.windowID)) this.lost(error)
          return undefined
        })
      : undefined
    if (revision !== this.revision) return
    if (!identity || pinned?.windowID !== current.windowID || pinned.identity !== identity) {
      this.scope = undefined
      this.driver.stopCapture()
    } else {
      const target = { windowID: current.windowID, identity }
      const scope = JSON.stringify([id, target])
      if (this.scope !== scope) {
        const fresh = await this.driver.probeCurrent!().catch((error: unknown) => {
          if (revision === this.revision) this.lost(error)
          return undefined
        })
        if (revision !== this.revision) return
        this.driver.stopCapture()
        this.scope = undefined
        if (fresh?.windowID === current.windowID) {
          this.scope = scope
          const fail = (error: unknown) => {
            if (revision === this.revision) this.lost(error)
          }
          try {
            this.driver.startCapture(fail, target)
          } catch (error) {
            fail(error)
          }
        }
      }
    }
    if (revision !== this.revision) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll(id, windows, revision)
    }, cadence)
  }

  private lost(error: unknown): void {
    this.fault = this.lease.current()?.id
    this.cancelPoll()
    this.scope = undefined
    this.driver.stopCapture()
    this.failed(error)
  }
}
