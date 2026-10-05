import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { Coordinator } from "./coordinator"
import { Settings } from "./settings"
import { Journal } from "./journal"
import { register as setup } from "./setup"

export function register(context: vscode.ExtensionContext, connection: KiloConnectionService) {
  const journal = new Journal(context.globalState)
  const owner = new Coordinator(connection, new Settings(context.globalState, context.secrets), journal)
  const command = setup(context, (config, token) => owner.configure(config, token))
  void owner.initialize().catch(() => {
    void vscode.window.showErrorMessage(
      "Home Assistant could not verify its saved connection. Reconnect through Raya: Connect Home Assistant.",
    )
  })
  const jobs = new Set<Promise<unknown>>()
  const state = { closed: false }
  const review = vscode.commands.registerCommand("kilo-code.new.reviewHomeAssistantAction", () => {
    if (state.closed) return
    const job = (async () => {
      const debt = journal.pending()
      if (!debt) {
        await vscode.window.showInformationMessage("Home Assistant has no uncertain action to review.")
        return
      }
      const choice = await vscode.window.showWarningMessage(
        "A previous Home Assistant action did not finish its confirmation. Inspect the allowed lights and any running script in Home Assistant before clearing its uncertainty. This does not repeat the action.",
        { modal: true },
        "I reviewed the action",
      )
      if (state.closed || choice !== "I reviewed the action") return
      await owner.reconcile(true)
      if (!state.closed)
        await vscode.window.showInformationMessage(
          "The original Home Assistant action was reconciled without repeating it.",
        )
    })()
      .catch(async () => {
        await vscode.window.showErrorMessage("Home Assistant action could not be reconciled. No action was repeated.")
      })
      .finally(() => {
        jobs.delete(job)
      })
    jobs.add(job)
    return job
  })
  let closing: Promise<void> | undefined
  const dispose = () => {
    state.closed = true
    // Both original fences begin before any other callback can publish or register a new generation.
    const start = (action: () => void | Promise<void>) => {
      try {
        return Promise.resolve(action())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    closing ??= (async () => {
      const results = await Promise.allSettled([
        start(() => review.dispose()),
        start(() => command.dispose()),
        start(() => owner.dispose()),
        ...jobs,
      ])
      const errors = [...new Set(results.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])))]
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Home Assistant host original closure failures retained")
    })()
    return closing
  }
  context.subscriptions.push({
    dispose() {
      void dispose().catch(() => console.warn("[Raya] Home Assistant original cleanup remains uncertain"))
    },
  })
  return { dispose }
}
