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
  beginTaskEvidence,
  endTaskEvidence,
  type TaskAuditIdentity,
  type TaskAuditRun,
  type TaskEvidenceRun,
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
    async (input?: { runId: string; scenario: string; sessionID: string }) => {
      if (context.globalState.get(key)) return unavailable("Another installed Desktop task boundary is still open")
      const before = await identity()
      if (!before) return unavailable("A source-matched active Windows host and lease are required")
      const evidence = await desktop.settledJournalEvidence(input?.sessionID ?? "")
      if (!evidence || JSON.stringify(before) !== JSON.stringify(await identity()))
        return unavailable("The host or durable action journal changed while opening the task boundary")
      const result = beginTaskEvidence(input?.runId ?? "", input?.scenario ?? "", before, evidence)
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

  const end = vscode.commands.registerCommand(
    "raya.endInstalledDesktopTaskAudit",
    async (input?: { runId: string; sessionID: string }) => {
      const run = context.globalState.get<TaskAuditRun | TaskEvidenceRun>(key)
      if (!run) return unavailable("No installed Desktop task boundary is open")
      if (run.version !== 2) return unavailable("The saved task boundary predates versioned action evidence")
      const after = await identity()
      if (!after) return unavailable("The installed Windows host or active lease is unavailable")
      const evidence = await desktop.settledJournalEvidence(input?.sessionID ?? "")
      if (!evidence || JSON.stringify(after) !== JSON.stringify(await identity()))
        return unavailable("The host or durable action journal changed while closing the task boundary")
      const result = endTaskEvidence(run, input?.runId ?? "", after, evidence)
      if (result.status === "available") await context.globalState.update(key, undefined)
      return result
    },
  )

  const clear = vscode.commands.registerCommand("raya.clearInstalledDesktopTaskAudit", async () => {
    await context.globalState.update(key, undefined)
    return { status: "cleared" as const, releaseGateEligible: false as const }
  })

  return vscode.Disposable.from(begin, end, clear)
}
