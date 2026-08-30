// raya_change - pseudo-auto-update off GitHub Releases for out-of-marketplace distribution.
// Polls the configured repo's latest Release, compares it to the installed version, and offers
// to download + install the VSIX that matches the current platform. Fails quietly on errors.
import * as vscode from "vscode"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INTERVAL_MS = 6 * 60 * 60 * 1000 // re-check every 6 hours while the window stays open
const FIRST_DELAY_MS = 30 * 1000 // let activation settle before the first background check
const DISMISS_KEY = "raya.update.dismissedVersion"
const REQUEST_TIMEOUT_MS = 15 * 1000

type Release = {
  tag_name: string
  name?: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: { name: string; url: string; browser_download_url: string }[]
}

type Config = { enabled: boolean; repo: string; token: string; includePrereleases: boolean }

const log = vscode.window.createOutputChannel("Raya Updates")

function config(): Config {
  const cfg = vscode.workspace.getConfiguration("raya.update")
  return {
    enabled: cfg.get<boolean>("enabled", true),
    repo: cfg.get<string>("repo", "").trim().replace(/^\/+|\/+$/g, ""),
    token: cfg.get<string>("token", "").trim(),
    includePrereleases: cfg.get<boolean>("includePrereleases", false),
  }
}

/** Parse a leading semver core (x.y.z) from a tag or version, ignoring any `v`/`raya-v` prefix and
 * build metadata. Returns the numeric triple plus whether a prerelease suffix (`-...`) is present. */
function parse(value: string): { core: [number, number, number]; pre: boolean } | undefined {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)(-[^+]+)?/)
  if (!match) return undefined
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: Boolean(match[4]) }
}

/** Returns >0 when `a` is newer than `b`. A release core beats its own prerelease. */
function compare(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  return pa.pre === pb.pre ? 0 : pa.pre ? -1 : 1
}

function currentTarget(): string {
  const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${os}-${arch}`
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
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/releases?per_page=30`, {
    headers: headers(cfg.token, "application/vnd.github+json"),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`)
  const releases = (await res.json()) as Release[]
  const eligible = releases.filter((r) => !r.draft && (cfg.includePrereleases || !r.prerelease))
  return eligible.toSorted((a, b) => compare(b.tag_name, a.tag_name))[0]
}

async function download(asset: Release["assets"][number], token: string, dest: string): Promise<void> {
  const res = await fetch(asset.url, {
    headers: headers(token, "application/octet-stream"),
    signal: AbortSignal.timeout(4 * REQUEST_TIMEOUT_MS),
  })
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  await vscode.workspace.fs.writeFile(vscode.Uri.file(dest), bytes)
}

async function installFrom(release: Release, cfg: Config, version: string): Promise<void> {
  const target = currentTarget()
  const vsix = release.assets.filter((a) => a.name.toLowerCase().endsWith(".vsix"))
  const asset = vsix.find((a) => a.name.includes(target)) ?? (vsix.length === 1 ? vsix[0] : undefined)
  if (!asset) {
    await vscode.window.showWarningMessage(
      `No Raya VSIX for your platform (${target}) is attached to ${release.tag_name}. Opening the release page.`,
    )
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url))
    return
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing Raya ${version}…` },
    async () => {
      const dest = join(tmpdir(), asset.name)
      await download(asset, cfg.token, dest)
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(dest))
      await vscode.workspace.fs.delete(vscode.Uri.file(dest)).then(undefined, () => undefined)
    },
  )
  const reload = await vscode.window.showInformationMessage(
    `Raya ${version} installed. Reload the window to apply it.`,
    "Reload",
  )
  if (reload === "Reload") await vscode.commands.executeCommand("workbench.action.reloadWindow")
}

async function check(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const cfg = config()
  if (!cfg.enabled && !manual) return
  if (!cfg.repo) {
    if (manual)
      await vscode.window.showInformationMessage("Set `raya.update.repo` (owner/name) to check for Raya updates.")
    return
  }

  const release = await latestRelease(cfg).catch((err) => {
    log.appendLine(`[check] ${err instanceof Error ? err.message : String(err)}`)
    if (manual) void vscode.window.showErrorMessage(`Could not check for Raya updates: ${String(err)}`)
    return undefined
  })
  if (!release) {
    if (manual) await vscode.window.showInformationMessage("No Raya releases were found in the configured repository.")
    return
  }

  const current = String(context.extension.packageJSON.version ?? "0.0.0")
  const version = release.tag_name.replace(/^raya-/, "").replace(/^v/, "")
  if (compare(release.tag_name, current) <= 0) {
    if (manual) await vscode.window.showInformationMessage(`Raya is up to date (${current}).`)
    return
  }

  if (!manual && context.globalState.get<string>(DISMISS_KEY) === version) return

  const choice = await vscode.window.showInformationMessage(
    `Raya ${version} is available (you have ${current.replace(/-snapshot.*$/, "")}).`,
    "Install",
    "View Release",
    "Later",
  )
  if (choice === "Install")
    await installFrom(release, cfg, version).catch((err) => {
      log.appendLine(`[install] ${err instanceof Error ? err.message : String(err)}`)
      void vscode.window.showErrorMessage(`Raya update failed: ${String(err)}`)
    })
  else if (choice === "View Release") await vscode.env.openExternal(vscode.Uri.parse(release.html_url))
  else if (choice === "Later") await context.globalState.update(DISMISS_KEY, version)
}

export function registerUpdateChecker(context: vscode.ExtensionContext): vscode.Disposable {
  const command = vscode.commands.registerCommand("raya.checkForUpdates", () => check(context, true))
  const first = setTimeout(() => void check(context, false), FIRST_DELAY_MS)
  const interval = setInterval(() => void check(context, false), INTERVAL_MS)
  return vscode.Disposable.from(command, log, {
    dispose: () => {
      clearTimeout(first)
      clearInterval(interval)
    },
  })
}
