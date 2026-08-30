// raya_change - owner design-system lock: pin generated UI to one approved system
import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

const KEY = "designSystem.lock"
const SOURCE_KEY = "designSystem.source"

function locked() {
  return vscode.workspace.getConfiguration("raya").get<boolean>(KEY, false)
}

function source() {
  return vscode.workspace.getConfiguration("raya").get<string>(SOURCE_KEY, "").trim() || undefined
}

// Push the persistent Raya setting to the backend, which stores it and injects a
// design-system reminder into prompts while locked. Mirrors grant-all-permissions.
async function apply(connection: KiloConnectionService) {
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const client = await connection.getClientAsync(dir)
  await client.kilocode.designSystem.set({ locked: locked(), source: source(), directory: dir })
}

export function registerDesignSystemLock(connection: KiloConnectionService): vscode.Disposable {
  void apply(connection).catch((err) =>
    console.error("raya: failed to apply designSystem.lock on activation", err),
  )
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(`raya.${KEY}`) && !event.affectsConfiguration(`raya.${SOURCE_KEY}`)) return
    void apply(connection).catch((err) => console.error("raya: failed to apply designSystem.lock change", err))
  })
}
