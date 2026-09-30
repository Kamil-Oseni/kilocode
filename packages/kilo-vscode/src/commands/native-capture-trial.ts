import * as vscode from "vscode"
import type { nativeCaptureTrial } from "./native-capture-trial-core"

export function registerNativeCaptureTrial(run: (signal: AbortSignal) => ReturnType<typeof nativeCaptureTrial>) {
  let active = false
  return vscode.commands.registerCommand("raya.nativeCaptureTrial", async () => {
    if (active)
      return {
        format: "raya.native-capture-trial",
        version: 1,
        releaseGateEligible: false,
        status: "unavailable",
        reason: "trial_busy",
      }
    active = true
    const controller = new AbortController()
    const result = await Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Measuring selected-window native capture (up to 60 seconds)",
          cancellable: true,
        },
        async (_, token) => {
          const off = token.onCancellationRequested(() => controller.abort())
          try {
            return await run(controller.signal)
          } finally {
            off.dispose()
          }
        },
      ),
    ).finally(() => {
      active = false
    })
    const document = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(result, null, 2) + "\n",
    })
    await vscode.window.showTextDocument(document, { preview: false })
    return result
  })
}
