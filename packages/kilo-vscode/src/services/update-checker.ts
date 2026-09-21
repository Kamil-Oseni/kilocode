// raya_change - pseudo-auto-update off GitHub Releases for out-of-marketplace distribution.
// Polls the configured repo's latest Release, compares it to the installed version, and offers
// to download + install the VSIX that matches the current platform. Fails quietly on errors.
import * as vscode from "vscode"
import { compare } from "./update-version"
import { configure, UpdateCredentials } from "./update-credentials"
import { select, stage } from "./update-artifact"
import { latest, remote } from "./update-release"
import { verify } from "./update-vsix"
import { UpdateRun } from "./update-run"
import { Installation } from "./update-installation"
import { PackageVault } from "./package-vault"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AdminUpdateSignal } from "../shared/admin"

const INTERVAL_MS = 6 * 60 * 60 * 1000 // re-check every 6 hours while the window stays open
const FIRST_DELAY_MS = 30 * 1000 // let activation settle before the first background check
const DISMISS_KEY = "raya.update.dismissedVersion"

type Release = NonNullable<ReturnType<typeof latest>>

type Config = { enabled: boolean; repo: string; token: string; includePrereleases: boolean }

const log = vscode.window.createOutputChannel("Raya Updates")
let health: AdminUpdateSignal["status"] = "not-checked"
let observed = ""

const identity = (settings: Omit<Config, "token">) => `${settings.repo}:${settings.includePrereleases ? "1" : "0"}`

export function updateAdminSignal(): AdminUpdateSignal {
  const settings = config()
  if (!settings.enabled || !settings.repo) return { status: "not-checked" }
  if (observed !== identity(settings)) return { status: "not-checked" }
  return { status: health }
}

function config(): Omit<Config, "token"> {
  const cfg = vscode.workspace.getConfiguration("raya.update")
  return {
    enabled: cfg.get("enabled", true),
    repo: cfg
      .get("repo", "")
      .trim()
      .replace(/^\/+|\/+$/g, ""),
    includePrereleases: cfg.get("includePrereleases", false),
  }
}

function currentTarget(): string {
  return `${process.platform}-${process.arch}`
}

async function latestRelease(cfg: Config): Promise<Release | undefined> {
  return remote(cfg.repo, cfg.includePrereleases, cfg.token)
}

async function installFrom(
  context: vscode.ExtensionContext,
  release: Release,
  cfg: Config,
  version: string,
  previous: string,
  active: () => boolean,
): Promise<void> {
  if (!active()) return
  const target = currentTarget()
  const asset = select(release.assets, target)
  if (!asset) {
    await vscode.window.showWarningMessage(
      `No Raya VSIX for your platform (${target}) is attached to ${release.tag_name}. Opening the release page.`,
    )
    if (!active()) return
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url))
    return
  }
  const result: { value?: Awaited<ReturnType<Installation["run"]>> } = {}
  const vault = new PackageVault(join(context.globalStorageUri.fsPath, "package-vault"))
  const binary = join(context.extensionUri.fsPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
  const rollback = await vault.activate(previous, target, binary)
  if (!rollback)
    throw new Error(`Raya ${previous} has no verified rollback package for ${target}. The update was not installed.`)
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing Raya ${version}…` },
    async () => {
      await stage(asset, cfg.repo, cfg.token, async (path) => {
        if (!active()) return
        await verify(path, { name: "raya", publisher: "eden", version, target })
        const retained = await vault.retain(path, {
          name: "raya",
          publisher: "eden",
          version,
          target,
        })
        if (!active()) return
        result.value = await new Installation(context.globalState, context.globalStorageUri.fsPath).run(
          {
            schema: 3,
            version,
            previous,
            repo: cfg.repo,
            target,
            asset: {
              name: asset.name,
              url: asset.url,
              size: asset.size,
              digest: asset.digest,
            },
            artifact: retained.artifact,
            binary: retained.binary,
            package: retained.package,
            rollback: {
              version: rollback.version,
              target: rollback.target,
              package: rollback.package,
              artifact: rollback.artifact,
              binary: rollback.binary,
            },
          },
          async () => {
            if (!active()) throw new Error("Update installation was canceled before dispatch.")
            await verify(retained.package, {
              name: "raya",
              publisher: "eden",
              version,
              target,
              artifact: retained.artifact,
              binary: retained.binary,
            })
            await vscode.commands.executeCommand(
              "workbench.extensions.installExtension",
              vscode.Uri.file(retained.package),
            )
          },
        )
      })
    },
  )
  if (!active()) return
  if (!result.value) return
  if (!result.value.dispatched && result.value.record.phase === "installing") {
    const reload = await vscode.window.showWarningMessage(
      `Raya already dispatched the ${version} installer, but completion was not confirmed. Reload the window to verify which version is active.`,
      "Reload",
      "Later",
    )
    if (reload === "Reload" && active()) await vscode.commands.executeCommand("workbench.action.reloadWindow")
    return
  }
  const reload = await vscode.window.showInformationMessage(
    `Raya ${version} installed. Reload the window to apply it.`,
    "Reload",
  )
  if (reload === "Reload" && active()) await vscode.commands.executeCommand("workbench.action.reloadWindow")
}

async function check(
  context: vscode.ExtensionContext,
  credentials: UpdateCredentials,
  manual: boolean,
  active: () => boolean,
): Promise<void> {
  const settings = config()
  const cfg: Config = { ...settings, token: "" }
  if (!cfg.enabled && !manual) return
  if (!cfg.repo) {
    if (manual)
      await vscode.window.showInformationMessage("Set `raya.update.repo` (owner/name) to check for Raya updates.")
    return
  }
  observed = identity(settings)
  health = "not-checked"

  try {
    cfg.token = await credentials.get()
  } catch {
    health = "failed"
    if (!active()) return
    log.appendLine("[check] Update credential migration failed; update check stopped.")
    if (manual)
      await vscode.window.showErrorMessage(
        "Could not load the update credential. Use Raya: Set Update Token to resolve it.",
      )
    return
  }
  if (!active()) return

  const result = await latestRelease(cfg)
    .then((release) => ({ release }))
    .catch((err) => {
      health = "failed"
      if (!active()) return undefined
      log.appendLine(`[check] ${err instanceof Error ? err.message : String(err)}`)
      if (manual) void vscode.window.showErrorMessage(`Could not check for Raya updates: ${String(err)}`)
      return undefined
    })
  if (!result || !active()) return
  const release = result.release
  if (!release) {
    health = "ready"
    if (manual) await vscode.window.showInformationMessage("No Raya releases were found in the configured repository.")
    return
  }

  const current = String(context.extension.packageJSON.version ?? "0.0.0")
  const version = release.tag_name.replace(/^raya-/, "").replace(/^v/, "")
  const order = (() => {
    try {
      return compare(release.tag_name, current)
    } catch {
      health = "failed"
      log.appendLine("[check] Update comparison stopped because the installed version is invalid.")
      if (manual)
        void vscode.window.showErrorMessage("Cannot determine update eligibility for this installed Raya version.")
      return undefined
    }
  })()
  if (order === undefined) return
  health = "ready"
  if (order <= 0) {
    if (manual) await vscode.window.showInformationMessage(`Raya is up to date (${current}).`)
    return
  }

  if (!manual && context.globalState.get<string>(DISMISS_KEY) === version) return

  await offer(context, cfg, release, version, current, active)
}

async function offer(
  context: vscode.ExtensionContext,
  cfg: Config,
  release: Release,
  version: string,
  current: string,
  active: () => boolean,
) {
  const choice = await vscode.window.showInformationMessage(
    `Raya ${version} is available (you have ${current.replace(/-snapshot.*$/, "")}).`,
    "Install",
    "View Release",
    "Later",
  )
  if (!active()) return
  if (choice === "Install")
    await installFrom(context, release, cfg, version, current, active).catch((err) => {
      if (!active()) return
      health = "failed"
      log.appendLine(`[install] ${err instanceof Error ? err.message : String(err)}`)
      void vscode.window.showErrorMessage(`Raya update failed: ${String(err)}`)
    })
  else if (choice === "View Release") await vscode.env.openExternal(vscode.Uri.parse(release.html_url))
  else if (choice === "Later") await context.globalState.update(DISMISS_KEY, version)
}

export function registerUpdateChecker(context: vscode.ExtensionContext): vscode.Disposable {
  const runner = new UpdateRun()
  const credentials = new UpdateCredentials(
    context.secrets,
    () => vscode.workspace.getConfiguration("raya.update"),
    context.globalStorageUri.fsPath,
  )
  const recovered = runner
    .run((active) => reconcile(context, active))
    .catch(() => {
      health = "failed"
      log.appendLine("[recovery] Could not reconcile the saved update installation record.")
      void vscode.window.showErrorMessage(
        "Raya could not verify its saved update recovery state. The record was retained and no installer was replayed.",
      )
    })
  void recovered
  const run = (manual: boolean) =>
    runner
      .run((active) => check(context, credentials, manual, active))
      .catch(() => {
        health = "failed"
        log.appendLine("[check] Update flow could not finish.")
      })
  const command = vscode.commands.registerCommand("raya.checkForUpdates", () => run(true))
  const token = vscode.commands.registerCommand("raya.setUpdateToken", () => configure(credentials))
  const acceptance =
    process.env.RAYA_UPDATE_SECRET_ACCEPTANCE === "1"
      ? vscode.commands.registerCommand("raya.internal.updateCredentialAcceptance", async (input: unknown) => {
          const parsed = input as { action?: unknown; token?: unknown }
          if (
            !parsed ||
            !["store", "read-clear"].includes(String(parsed.action)) ||
            typeof parsed.token !== "string" ||
            parsed.token.length < 16 ||
            parsed.token.length > 256
          )
            throw new Error("Invalid update credential acceptance request.")
          if (parsed.action === "store") {
            await credentials.set(parsed.token)
            return { saved: (await credentials.get()) === parsed.token }
          }
          const saved = (await credentials.get()) === parsed.token
          await credentials.set("")
          return { saved, cleared: (await credentials.get()) === "" }
        })
      : new vscode.Disposable(() => undefined)
  const phase = process.env.RAYA_UPDATE_SECRET_PHASE
  const secret = process.env.RAYA_UPDATE_SECRET_TOKEN
  const output = process.env.RAYA_UPDATE_SECRET_RESULT
  if (process.env.RAYA_UPDATE_SECRET_ACCEPTANCE === "1" && phase && secret && output)
    void Promise.resolve(
      vscode.commands.executeCommand("raya.internal.updateCredentialAcceptance", { action: phase, token: secret }),
    )
      .then((result) => writeFile(output, JSON.stringify(result), { flag: "wx" }))
      .catch(() => writeFile(output, JSON.stringify({ error: true }), { flag: "wx" }))
      .finally(() => vscode.commands.executeCommand("workbench.action.quit"))
  const first = setTimeout(() => void run(false), FIRST_DELAY_MS)
  const interval = setInterval(() => void run(false), INTERVAL_MS)
  return vscode.Disposable.from(command, token, acceptance, runner, log, {
    dispose: () => {
      clearTimeout(first)
      clearInterval(interval)
    },
  })
}

export async function reconcile(context: vscode.ExtensionContext, active: () => boolean) {
  const current = String(context.extension.packageJSON.version)
  const target = currentTarget()
  const binary = join(context.extensionUri.fsPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
  const vault = new PackageVault(join(context.globalStorageUri.fsPath, "package-vault"))
  const verified = await vault.activate(current, target, binary)
  const journal = new Installation(context.globalState, context.globalStorageUri.fsPath)
  const record = await journal.recover(verified)
  if (!record || !active()) return
  const rolling = "schema" in record && record.schema === 3 && record.phase.startsWith("rollback-")
  const choices = rolling ? (["Reload", "Later"] as const) : (["Reload", "Restore previous", "Later"] as const)
  const choice = await vscode.window.showWarningMessage(
    rolling
      ? `Raya dispatched rollback to ${record.previous}, but this extension host is running ${current}. Reload to verify the restored version.`
      : `Raya recorded an update to ${record.version}, but this extension host is running ${current}. Reload to verify it, or restore the retained ${record.previous} package.`,
    ...choices,
  )
  if (choice === "Reload" && active()) await vscode.commands.executeCommand("workbench.action.reloadWindow")
  if (choice !== "Restore previous" || !active()) return
  if (!("schema" in record) || record.schema !== 3) {
    await vscode.window.showErrorMessage("This older update record has no verified rollback package.")
    return
  }
  const result = await journal
    .rollback(async (path) => {
      if (!active()) throw new Error("Update rollback was canceled before dispatch.")
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(path))
    })
    .catch(async () => {
      if (active())
        await vscode.window.showErrorMessage(
          "Raya could not confirm rollback. The exact recovery record was retained and the installer will not be replayed.",
        )
      return undefined
    })
  if (!result || !active()) return
  const notice = result.dispatched
    ? `Raya ${record.previous} was restored. Reload the window to activate and verify it.`
    : `Rollback to Raya ${record.previous} was already dispatched. Reload the window to verify it.`
  const reload = await vscode.window.showInformationMessage(notice, "Reload", "Later")
  if (reload === "Reload" && active()) await vscode.commands.executeCommand("workbench.action.reloadWindow")
}
