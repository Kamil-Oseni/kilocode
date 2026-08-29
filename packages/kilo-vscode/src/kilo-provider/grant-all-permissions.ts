// raya_change - global owner toggle: grant every agent every tool across all workspaces
import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

const KEY = "permissions.grantAllTools"

function enabled() {
  return vscode.workspace.getConfiguration("raya").get<boolean>(KEY, false)
}

// The backend already exposes a global allow-everything primitive (the TUI uses it): with no
// sessionID it writes an allow-all rule to the global Kilo config and flips the runtime bypass,
// so it applies to every workspace and survives restarts. We drive that primitive from a
// persistent Raya setting so the owner can turn fully-autonomous agents on or off in one place.
async function apply(connection: KiloConnectionService, enable: boolean) {
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const client = await connection.getClientAsync(dir)
  await client.permission.allowEverything({ enable, directory: dir })
}

export function registerGrantAllPermissions(connection: KiloConnectionService): vscode.Disposable {
  void apply(connection, enabled()).catch((err) =>
    console.error("raya: failed to apply grantAllTools on activation", err),
  )
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(`raya.${KEY}`)) return
    void apply(connection, enabled()).catch((err) =>
      console.error("raya: failed to apply grantAllTools change", err),
    )
  })
}
