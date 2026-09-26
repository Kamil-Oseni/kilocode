import * as vscode from "vscode"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PackageVault } from "../services/package-vault"
import { WindowsDesktopDriver } from "../services/computer-use/desktop-windows"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ComputerUseLeaseStore } from "../services/computer-use/lease-store"
import type { DesktopAutomationService } from "../services/computer-use/desktop-service"
import { inspectInstalledHost } from "./installed-desktop-host-core"
import { desktopNames } from "./windows-desktop-name"

export function registerInstalledDesktopHost(
  context: vscode.ExtensionContext,
  connection: KiloConnectionService,
  lease: ComputerUseLeaseStore,
  desktop: DesktopAutomationService,
) {
  return vscode.commands.registerCommand(
    "raya.inspectInstalledDesktopHost",
    async (expected?: { version: string; digest: string; captureSha256?: string }) => {
      const vault = new PackageVault(join(context.globalStorageUri.fsPath, "package-vault"))
      const active = await Promise.race([
        vault.current().then(
          (value) => value,
          () => undefined,
        ),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
      ])
      const driver = process.platform === "win32" ? new WindowsDesktopDriver() : undefined
      const names = await desktopNames().then(
        (value) => value,
        () => ({}),
      )
      const capture = await readFile(join(context.extensionPath, "bin", "raya-desktop-capture.exe")).then(
        (value) => createHash("sha256").update(value).digest("hex"),
        () => undefined,
      )
      const lost = { value: false }
      const off = connection.onStateChange((state) => {
        if (state !== "connected") lost.value = true
      })
      const timeout = setTimeout(() => driver?.cancel(), 15_000)
      const probe = inspectInstalledHost({
        loadedVersion: String(context.extension.packageJSON.version),
        loadedCaptureSha256: capture,
        active: active ? { version: active.version, digest: active.artifact.digest } : undefined,
        expected,
        desktop: names,
        backend: () => (lost.value ? "disconnected" : connection.getConnectionState()),
        process: () => connection.currentProcessIdentity(),
        lease: () => lease.summary(),
        journal: () => desktop.journalEvidence(),
        observe: async () => {
          if (!driver) throw new Error("Windows desktop is unavailable")
          const before = await driver.current()
          const initial = await driver.identity(before.windowID)
          const frame = await driver.observe({ fresh: true })
          const identity = await driver.identity(frame.windowID)
          const after = await driver.current()
          return {
            before: { ...before, identity: initial },
            after: { ...after, identity },
            window: { windowID: frame.windowID, location: frame.location },
            width: frame.width,
            height: frame.height,
            timing: frame.timing,
            semantics: frame.semantics
              ? {
                  status: frame.semantics.status,
                  count: frame.semantics.controls.length,
                  truncated: frame.semantics.truncated,
                }
              : undefined,
          }
        },
      })
      const report = await probe.finally(() => {
        clearTimeout(timeout)
        off()
        driver?.cancel()
      })
      const document = await vscode.workspace.openTextDocument({
        language: "json",
        content: JSON.stringify(report, null, 2) + "\n",
      })
      await vscode.window.showTextDocument(document, { preview: false })
      return report
    },
  )
}
