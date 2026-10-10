import * as vscode from "vscode"
import { lstat } from "node:fs/promises"
import { Schema } from "effect"
import { SourceSelection } from "@opencode-ai/core/kilocode/source-selection-schema"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { archive } from "./archive"

export function registerArchive(context: vscode.ExtensionContext, connection: KiloConnectionService) {
  let active = false
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.exportPartialProfileArchive", async () => {
      if (active) return vscode.window.showWarningMessage("A profile archive review is already in progress.")
      active = true
      let started = false
      try {
        const client = connection.getClient()
        const response = await client.global.sourceExportSelection({ throwOnError: true })
        const review = Schema.decodeUnknownSync(SourceSelection)(response.data, { onExcessProperty: "error" })
        if (!connection.isClientCurrent(client) || !connection.matchesSource(review.source))
          throw new Error("selection")
        const output = await vscode.window.showSaveDialog({
          title: "Choose a new encrypted partial-profile archive",
          filters: { "Encrypted Raya archive": ["raya"] },
        })
        if (!output) return
        if (output.scheme !== "file") throw new Error("location")
        const exists = await lstat(output.fsPath).catch((err: unknown) => {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
          throw err
        })
        if (exists) return vscode.window.showErrorMessage("Choose a new file. Existing archives are never overwritten.")
        const password = await vscode.window.showInputBox({
          title: "Encrypt this partial-profile archive",
          password: true,
          ignoreFocusOut: true,
          prompt: "Use a password of 12–1024 UTF-8 bytes. Keep it separately; Raya cannot recover it.",
          validateInput: (value) => {
            const bytes = Buffer.byteLength(value, "utf8")
            return bytes < 12 || bytes > 1024
              ? "Use 12–1024 UTF-8 bytes; non-ASCII characters may use more than one byte."
              : undefined
          },
        })
        if (password === undefined) return
        const confirmation = await vscode.window.showWarningMessage(
          `Create a partial encrypted archive at ${output.fsPath}?\nDatabase: ${review.profile.database}\nStorage: ${review.profile.storage}\nThis is not a complete PC or Raya backup. Configuration and client preferences are included only through authenticated capture. Pause active work first. Capture retires this backend and its views even on refusal; reload this window afterward.`,
          { modal: true },
          "Create partial archive",
        )
        if (confirmation !== "Create partial archive") return
        const result = await archive(connection, review, password, output.fsPath, () => {
          started = true
        })
        if (result.result.status !== "exported" || !result.result.artifact) {
          await vscode.window.showErrorMessage(
            "Archive was refused. No successful backup is claimed. Reload this window before continuing.",
          )
          return
        }
        const file = result.result.artifact
        await vscode.window.showInformationMessage(
          `Partial encrypted archive created: ${file.output}\n${file.bytes} bytes; SHA-256 ${file.digest}\nReload this window before continuing. Full restoration has not been verified.`,
        )
      } catch {
        await vscode.window.showErrorMessage(
          started
            ? "Partial archive could not be confirmed. Do not retry automatically; review the destination and reload this window."
            : "Archive sources are unavailable or changed. No capture was requested. Connect the current backend and review again.",
        )
      } finally {
        active = false
      }
    }),
  )
}
