import { randomUUID } from "node:crypto"
import { TargetError } from "./browser-target"

export interface NativeDialog {
  type(): "alert" | "confirm" | "prompt" | "beforeunload"
  message(): string
  defaultValue(): string
  accept(text?: string): Promise<void>
  dismiss(): Promise<void>
}
export interface DialogPage {
  on(event: "dialog", listener: (dialog: NativeDialog) => void): void
  on(event: "close", listener: () => void): void
  off(event: "dialog", listener: (dialog: NativeDialog) => void): void
  off(event: "close", listener: () => void): void
}
export type DialogInfo = {
  id: string
  tabID: string
  operationID?: string
  type: ReturnType<NativeDialog["type"]>
  message: string
  defaultValue: string
  status: "open" | "resolving" | "accepted" | "dismissed" | "unknown" | "closed"
  truncated: boolean
}
export type DialogOperation = {
  id: string
  tabID: string
  operation: string
  status: "pending" | "completed" | "failed"
  output?: string
  error?: string
  truncated?: boolean
}
export function pending<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Entry = { info: DialogInfo; native: NativeDialog; settled: ReturnType<typeof pending<void>> }
type Running = { info: DialogOperation; signal: ReturnType<typeof pending<never>>; interrupted: boolean }

export class DialogPendingError extends Error {
  readonly name = "BrowserDialogPendingError"
  constructor(operation: DialogOperation, dialogID?: string) {
    super(
      `Browser operation remains pending and must not be retried. Use browser_dialog list with tab_id=${operation.tabID}, ${operation.id === "manual" ? "without an operation_id" : `operation_id=${operation.id}`}${dialogID ? `; dialog_id=${dialogID}` : ""}. Dialog response is not completion.`,
    )
  }
}

export class BrowserDialogs {
  private readonly entries = new Map<string, Entry>()
  private readonly operations = new Map<string, DialogOperation>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanup: Array<() => void> = []
  private current?: Running
  private disposed = false
  private readonly stopped = pending<void>()

  attach(page: DialogPage, tabID: string): void {
    const opened = (native: NativeDialog) => {
      const current =
        this.current && (!this.current.info.tabID || this.current.info.tabID === tabID) ? this.current : undefined
      if (current && !current.info.tabID) current.info.tabID = tabID
      const message = native.message()
      const value = native.defaultValue()
      const info: DialogInfo = {
        id: randomUUID(),
        tabID,
        operationID: current?.info.id,
        type: native.type(),
        message: message.slice(0, 10_000),
        defaultValue: value.slice(0, 10_000),
        truncated: message.length > 10_000 || value.length > 10_000,
        status: "open",
      }
      for (const [id, entry] of this.entries) {
        if (this.entries.size < 1024) break
        if (["accepted", "dismissed", "closed"].includes(entry.info.status)) this.entries.delete(id)
      }
      this.entries.set(info.id, { info, native, settled: pending<void>() })
      if (current) {
        current.interrupted = true
        current.signal.reject(new DialogPendingError(current.info, info.id))
      }
      this.publish()
    }
    const closed = () => {
      for (const entry of this.entries.values()) {
        if (entry.info.tabID !== tabID || !["open", "resolving", "unknown"].includes(entry.info.status)) continue
        entry.info.status = "closed"
        entry.settled.resolve()
      }
      this.publish()
    }
    page.on("dialog", opened)
    page.on("close", closed)
    this.cleanup.push(() => {
      page.off("dialog", opened)
      page.off("close", closed)
    })
  }

  blocked(): DialogPendingError | undefined {
    if (this.current?.interrupted) return new DialogPendingError(this.current.info)
    const open = [...this.entries.values()].find((entry) =>
      ["open", "resolving", "unknown"].includes(entry.info.status),
    )
    if (open)
      return new DialogPendingError(
        { id: open.info.operationID ?? "manual", tabID: open.info.tabID, operation: "manual", status: "pending" },
        open.info.id,
      )
  }

  start<T>(operation: string, tabID: string, run: () => Promise<T>) {
    if (this.disposed) throw new TargetError("Browser dialog inspection was disposed")
    if (this.operations.size >= 1024)
      throw new TargetError(
        "Browser operation inspection capacity reached; no action dispatched. Inspect retained outcomes before intentionally reloading the extension.",
      )
    const info: DialogOperation = { id: randomUUID(), tabID, operation, status: "pending" }
    const running: Running = { info, signal: pending<never>(), interrupted: false }
    this.operations.set(info.id, info)
    this.current = running
    const task = Promise.resolve().then(run)
    const settled = Promise.race([
      task,
      this.stopped.promise.then(() => {
        throw new Error("Browser disposed; originating operation outcome is uncertain and must not be replayed")
      }),
    ])
      .then(
        (result) => {
          info.status = "completed"
          try {
            const text = JSON.stringify(result)
            info.output = text.slice(0, 32_000)
            info.truncated = text.length > 32_000
          } catch {
            info.output = "Operation completed, but its result could not be serialized."
            info.truncated = true
          }
          return result
        },
        (error: unknown) => {
          info.status = "failed"
          info.error = (error instanceof Error ? error.message : String(error)).slice(0, 10_000)
          throw error
        },
      )
      .finally(() => {
        if (!running.interrupted) this.operations.delete(info.id)
        for (const entry of this.entries.values()) {
          if (info.status === "completed" && entry.info.operationID === info.id && entry.info.status === "unknown")
            entry.info.status = "closed"
        }
        if (this.current === running) this.current = undefined
        this.publish()
      })
    return { settled, result: Promise.race([settled, running.signal.promise]) }
  }

  list(tabID?: string, operationID?: string) {
    if (operationID && (!this.operations.has(operationID) || this.operations.get(operationID)?.tabID !== tabID))
      throw new TargetError("Browser operation identity is unknown for this tab")
    const entries = [...this.entries.values()]
    const active = entries.filter((entry) => ["open", "resolving", "unknown"].includes(entry.info.status))
    const history = entries.filter((entry) => !["open", "resolving", "unknown"].includes(entry.info.status)).slice(-20)
    return {
      dialogs: [...active, ...history]
        .filter(
          (entry) => (!tabID || entry.info.tabID === tabID) && (!operationID || entry.info.operationID === operationID),
        )
        .map((entry) => ({ ...entry.info })),
      operations: [...this.operations.values()]
        .filter((operation) => (!tabID || operation.tabID === tabID) && (!operationID || operation.id === operationID))
        .slice(-50)
        .map((operation) => ({ ...operation })),
    }
  }

  async answer(tabID: string, id: string, action: "accept" | "dismiss", text?: string): Promise<void> {
    if (action !== "accept" && action !== "dismiss")
      throw new TargetError("Dialog response must be accept or dismiss. No response was sent.")
    const entry = this.entries.get(id)
    if (this.disposed || !entry || entry.info.tabID !== tabID || entry.info.status !== "open")
      throw new TargetError(
        "Dialog identity is stale, already claimed, or belongs to another tab. No response was sent.",
      )
    if (
      text !== undefined &&
      (action !== "accept" || entry.info.type !== "prompt" || typeof text !== "string" || text.length > 10_000)
    )
      throw new TargetError(
        "Response text is allowed only for accepting a prompt and must be at most 10,000 characters",
      )
    entry.info.status = "resolving"
    this.publish()
    try {
      if (action === "accept") await entry.native.accept(text)
      else await entry.native.dismiss()
      entry.info.status = action === "accept" ? "accepted" : "dismissed"
    } catch (error) {
      entry.info.status =
        this.operations.get(entry.info.operationID ?? "")?.status === "completed" ? "closed" : "unknown"
      throw new Error(
        `Dialog response outcome is uncertain; it will not be sent again. ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      entry.settled.resolve()
      this.publish()
    }
  }

  async unload(tabID: string, run: () => Promise<void>, closed: Promise<void>, isClosed: () => boolean): Promise<void> {
    const before = new Set(this.entries.keys())
    const arrived = pending<Entry>()
    const off = this.onChange(() => {
      const entry = [...this.entries.values()].find(
        (entry) => !before.has(entry.info.id) && entry.info.tabID === tabID && entry.info.type === "beforeunload",
      )
      if (entry) arrived.resolve(entry)
    })
    try {
      await Promise.race([
        run(),
        this.stopped.promise.then(() => {
          throw new Error("Browser disposed during tab closure; outcome uncertain")
        }),
      ])
      if (this.disposed) throw new Error("Browser disposed during tab closure; outcome uncertain")
      if (isClosed()) return
      const entry = await Promise.race([
        arrived.promise,
        closed.then(() => undefined),
        this.stopped.promise.then(() => {
          throw new Error("Browser disposed during tab closure; outcome uncertain")
        }),
      ])
      if (!entry) return
      await entry.settled.promise
      if (this.disposed) throw new Error("Browser disposed during tab closure; outcome uncertain")
      if (entry.info.status === "dismissed")
        throw new TargetError("Beforeunload was dismissed; the tab remains open and closure was not completed")
      if (entry.info.status === "unknown") throw new Error("Tab closure remains uncertain after beforeunload response")
      await Promise.race([
        closed,
        this.stopped.promise.then(() => {
          throw new Error("Browser disposed during tab closure; outcome uncertain")
        }),
      ])
    } finally {
      off()
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(): void {
    for (const listener of this.listeners) listener()
  }
  dispose(): void {
    this.disposed = true
    this.stopped.resolve()
    for (const entry of this.entries.values()) {
      if (["open", "resolving", "unknown"].includes(entry.info.status)) entry.info.status = "unknown"
      entry.settled.resolve()
    }
    for (const cleanup of this.cleanup) cleanup()
    this.cleanup.length = 0
    this.listeners.clear()
  }
}
