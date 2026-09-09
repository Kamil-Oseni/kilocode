// raya_change - pseudo-auto-update off GitHub Releases for out-of-marketplace distribution.
// Polls the configured repo's latest Release, compares it to the installed version, and offers
// to download + install the VSIX that matches the current platform. Fails quietly on errors.
import * as vscode from "vscode"
import { compare } from "./update-version"
import { configure, UpdateCredentials } from "./update-credentials"
import { select, stage } from "./update-artifact"
import { latest, scan } from "./update-release"
import { verify } from "./update-vsix"
import { UpdateRun } from "./update-run"
import { Installation } from "./update-installation"

const INTERVAL_MS = 6 * 60 * 60 * 1000 // re-check every 6 hours while the window stays open
const FIRST_DELAY_MS = 30 * 1000 // let activation settle before the first background check
const DISMISS_KEY = "raya.update.dismissedVersion"
const REQUEST_TIMEOUT_MS = 15 * 1000

type Release = NonNullable<ReturnType<typeof latest>>

type Config = { enabled: boolean; repo: string; token: string; includePrereleases: boolean }

const log = vscode.window.createOutputChannel("Raya Updates")

function config(): Omit<Config, "token"> {
  const cfg = vscode.workspace.getConfiguration("raya.update")
  return {
    enabled: cfg.get<boolean>("enabled", true),
    repo: cfg
      .get<string>("repo", "")
      .trim()
      .replace(/^\/+|\/+$/g, ""),
    includePrereleases: cfg.get<boolean>("includePrereleases", false),
  }
}

function currentTarget(): string {
  return `${process.platform}-${process.arch}`
}

function headers(token: string, accept: string): Record<string, string> {
  const base: Record<string, string> = {
    Accept: accept,
    "User-Agent": "raya-update-checker",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  if (token) base["Authorization"] = `Bearer ${token}`
  return base
}

async function latestRelease(cfg: Config): Promise<Release | undefined> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return scan(cfg.repo, cfg.includePrereleases, (url) =>
    fetch(url, {
      headers: headers(cfg.token, "application/vnd.github+json"),
      signal,
      redirect: "error",
    }),
  )
}

async function installFrom(
  context: vscode.ExtensionContext,
  release: Release,
  cfg: Config,
  version: string,
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
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing Raya ${version}…` },
    async () => {
      await stage(asset, cfg.repo, cfg.token, async (path) => {
        if (!active()) return
        await verify(path, { name: "raya", publisher: "eden", version, target })
        if (!active()) return
        await new Installation(context.globalState).run(
          version,
          String(context.extension.packageJSON.version),
          async () => {
            if (!active()) throw new Error("Update installation was canceled before dispatch.")
            await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(path))
          },
        )
      })
    },
  )
  if (!active()) return
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

  try {
    cfg.token = await credentials.get()
  } catch {
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
      if (!active()) return undefined
      log.appendLine(`[check] ${err instanceof Error ? err.message : String(err)}`)
      if (manual) void vscode.window.showErrorMessage(`Could not check for Raya updates: ${String(err)}`)
      return undefined
    })
  if (!result || !active()) return
  const release = result.release
  if (!release) {
    if (manual) await vscode.window.showInformationMessage("No Raya releases were found in the configured repository.")
    return
  }

  const current = String(context.extension.packageJSON.version ?? "0.0.0")
  const version = release.tag_name.replace(/^raya-/, "").replace(/^v/, "")
  const order = (() => {
    try {
      return compare(release.tag_name, current)
    } catch {
      log.appendLine("[check] Update comparison stopped because the installed version is invalid.")
      if (manual)
        void vscode.window.showErrorMessage("Cannot determine update eligibility for this installed Raya version.")
      return undefined
    }
  })()
  if (order === undefined) return
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
    await installFrom(context, release, cfg, version, active).catch((err) => {
      if (!active()) return
      log.appendLine(`[install] ${err instanceof Error ? err.message : String(err)}`)
      void vscode.window.showErrorMessage(`Raya update failed: ${String(err)}`)
    })
  else if (choice === "View Release") await vscode.env.openExternal(vscode.Uri.parse(release.html_url))
  else if (choice === "Later") await context.globalState.update(DISMISS_KEY, version)
}

export function registerUpdateChecker(context: vscode.ExtensionContext): vscode.Disposable {
  const runner = new UpdateRun()
  const credentials = new UpdateCredentials(context.secrets, () => vscode.workspace.getConfiguration("raya.update"))
  const recovered = runner
    .run(async (active) => {
      const current = String(context.extension.packageJSON.version)
      const record = await new Installation(context.globalState).recover(current)
      if (!record || !active()) return
      const choice = await vscode.window.showWarningMessage(
        `Raya recorded an update to ${record.version}, but this extension host is running ${current}. Reload to verify the installation, or use Check for Updates to retry.`,
        "Reload",
        "Later",
      )
      if (choice === "Reload" && active()) await vscode.commands.executeCommand("workbench.action.reloadWindow")
    })
    .catch(() => log.appendLine("[recovery] Could not reconcile the saved update installation record."))
  void recovered
  const run = (manual: boolean) =>
    runner
      .run((active) => check(context, credentials, manual, active))
      .catch(() => {
        log.appendLine("[check] Update flow could not finish.")
      })
  const command = vscode.commands.registerCommand("raya.checkForUpdates", () => run(true))
  const token = vscode.commands.registerCommand("raya.setUpdateToken", () => configure(credentials))
  const first = setTimeout(() => void run(false), FIRST_DELAY_MS)
  const interval = setInterval(() => void run(false), INTERVAL_MS)
  return vscode.Disposable.from(command, token, runner, log, {
    dispose: () => {
      clearTimeout(first)
      clearInterval(interval)
    },
  })
}
