import type { KiloClient } from "@kilocode/sdk/v2/client"
import * as vscode from "vscode"
import type { ConnectionState, KiloConnectionService } from "./cli-backend/connection-service"

const ACTION = "Open Todo"
const INTERVAL = 60_000

type Connection = Pick<KiloConnectionService, "getClient" | "getConnectionState" | "onStateChange">
type Reminder = NonNullable<Awaited<ReturnType<KiloClient["raya"]["personalTodo"]["reminders"]>>["data"]>[number]

type Host = {
  show(message: string, action: string): Thenable<string | undefined>
  execute(command: string): Thenable<unknown>
  schedule(callback: () => void, delay: number): vscode.Disposable
}

const host: Host = {
  show: (message, action) => vscode.window.showInformationMessage(message, action),
  execute: (command) => vscode.commands.executeCommand(command),
  schedule: (callback, delay) => {
    const timer = setInterval(callback, delay)
    return new vscode.Disposable(() => clearInterval(timer))
  },
}

export class PersonalTodoReminderCoordinator implements vscode.Disposable {
  private timer?: vscode.Disposable
  private active = false
  private pending = false
  private closed = false
  private readonly unsubscribe: () => void

  constructor(
    private readonly connection: Connection,
    private readonly ui: Host = host,
  ) {
    this.unsubscribe = connection.onStateChange((state) => this.changed(state))
    this.changed(connection.getConnectionState())
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.timer?.dispose()
    this.timer = undefined
  }

  private changed(state: ConnectionState): void {
    if (this.closed) return
    if (state !== "connected") {
      this.pending = false
      this.timer?.dispose()
      this.timer = undefined
      return
    }
    if (!this.timer) this.timer = this.ui.schedule(() => this.request(), INTERVAL)
    this.request()
  }

  private request(): void {
    this.pending = true
    void this.poll()
  }

  private async poll(): Promise<void> {
    if (this.closed || this.active || !this.pending || this.connection.getConnectionState() !== "connected") return
    this.pending = false
    this.active = true
    await this.claim().catch(() => undefined)
    this.active = false
    if (this.pending) void this.poll()
  }

  private async claim(): Promise<void> {
    const client = this.connection.getClient()
    const result = await client.raya.personalTodo.reminders()
    await Promise.all((result.data ?? []).map((reminder) => this.present(reminder)))
  }

  private async present(reminder: Reminder): Promise<void> {
    const choice = this.dispatch(reminder)
    if (!choice) return
    void Promise.resolve(choice)
      .then(async (choice) => {
        if (choice === ACTION) await Promise.resolve(this.ui.execute("raya.todosButtonClicked")).catch(() => undefined)
      })
      .catch(() => undefined)
    if (this.closed || this.connection.getConnectionState() !== "connected") return
    await this.connection
      .getClient()
      .raya.personalTodo.acknowledgeReminder({ deliveryID: reminder.deliveryID, claimID: reminder.claimID })
  }

  private dispatch(reminder: Reminder): Thenable<string | undefined> | undefined {
    try {
      return this.ui.show(`Todo reminder: ${reminder.title}`, ACTION)
    } catch {
      return undefined
    }
  }
}
