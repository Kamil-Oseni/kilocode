import * as vscode from "vscode"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PackageVault } from "../services/package-vault"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ComputerUseLeaseStore } from "../services/computer-use/lease-store"
import type { DesktopAutomationService } from "../services/computer-use/desktop-service"
import { desktopNames } from "./windows-desktop-name"
import {
  beginTaskAudit,
  endTaskAudit,
  type TaskAuditIdentity,
  type TaskAuditRun,
} from "./installed-desktop-task-audit-session"

const key = "raya.installedDesktopTaskAudit.v1"

function unavailable(reason: string) {
  return { status: "unavailable" as const, reason, releaseGateEligible: false as const }
}

/** Internal evaluation hooks. They capture metadata only and never move the foreground. */
export function registerInstalledDesktopTaskAudit(
  context: vscode.ExtensionContext,
  connection: KiloConnectionService,
  lease: ComputerUseLeaseStore,
  desktop: DesktopAutomationService,
) {
  const vault = new PackageVault(join(context.globalStorageUri.fsPath, "package-vault"))
  const identity = async (): Promise<TaskAuditIdentity | null> => {
    if (process.platform !== "win32" || connection.getConnectionState() !== "connected") return null
    const before = connection.currentProcessIdentity()
    const grant = lease.summary()
    if (!before || !grant || grant.state !== "active") return null
    const [active, names, capture] = await Promise.all([
      vault.current().catch(() => undefined),
      desktopNames().catch(() => ({ host: undefined, input: undefined })),
      readFile(join(context.extensionPath, "bin", "raya-desktop-capture.exe")).then(
        (value) => createHash("sha256").update(value).digest("hex"),
        () => undefined,
      ),
    ])
    const after = connection.currentProcessIdentity()
    if (
      connection.getConnectionState() !== "connected" ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(grant) !== JSON.stringify(lease.summary()) ||
      !active ||
      active.version !== context.extension.packageJSON.version ||
      !capture ||
      !names.host ||
      names.host !== names.input
    )
      return null
    return {
      version: active.version,
      digest: active.artifact.digest,
      captureSha256: capture,
      backend: before,
      lease: { grantHash: grant.grantHash, level: grant.level, state: "active" },
      desktop: { host: names.host, input: names.input },
    }
  }

  const begin = vscode.commands.registerCommand(
    "raya.beginInstalledDesktopTaskAudit",
    async (input?: { runId: string; scenario: string }) => {
      if (context.globalState.get(key)) return unavailable("Another installed Desktop task boundary is still open")
      const before = await identity()
      if (!before) return unavailable("A source-matched active Windows host and lease are required")
      const audit = await desktop.settledJournalAudit()
      if (!audit || JSON.stringify(before) !== JSON.stringify(await identity()))
        return unavailable("The host or durable native journal changed while opening the task boundary")
      const result = beginTaskAudit(input?.runId ?? "", input?.scenario ?? "", before, audit)
      if (result.status !== "ready") return result
      await context.globalState.update(key, result.boundary)
      return {
        status: "ready" as const,
        runId: result.boundary.runId,
        scenario: result.boundary.scenario,
        releaseGateEligible: false as const,
      }
    },
  )

  const end = vscode.commands.registerCommand("raya.endInstalledDesktopTaskAudit", async (runId?: string) => {
    const run = context.globalState.get<TaskAuditRun>(key)
    if (!run) return unavailable("No installed Desktop task boundary is open")
    const after = await identity()
    if (!after) return unavailable("The installed Windows host or active lease is unavailable")
    const audit = await desktop.settledJournalAudit()
    if (!audit || JSON.stringify(after) !== JSON.stringify(await identity()))
      return unavailable("The host or durable native journal changed while closing the task boundary")
    const result = endTaskAudit(run, runId ?? "", after, audit)
    if (result.status === "available") await context.globalState.update(key, undefined)
    return result
  })

  const clear = vscode.commands.registerCommand("raya.clearInstalledDesktopTaskAudit", async () => {
    await context.globalState.update(key, undefined)
    return { status: "cleared" as const, releaseGateEligible: false as const }
  })

  return vscode.Disposable.from(begin, end, clear)
}
