#!/usr/bin/env bun
// raya_change - Raya snapshot artifact identity
import { $ } from "bun"
import { createRequire } from "node:module"
import { join, dirname, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { rmSync, mkdirSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { load, identity, digest } from "../../opencode/src/kilocode/self-heal/build-input"
import { PackageVault } from "../src/services/package-vault"
import { prune } from "./snapshot-retention"

const mode = process.argv[2] ?? "install"
const shouldInstall = mode === "install"
// raya_change - "release" builds a versioned, platform-targeted VSIX into out/ for a GitHub Release
const isRelease = mode === "release"

const root = join(import.meta.dir, "..")
const capture = join(root, "bin", "raya-desktop-capture.exe")
const symbols = join(root, "bin", "raya-desktop-capture.pdb")
const input = join(root, "bin", "raya-desktop-input.exe")
const inputSymbols = join(root, "bin", "raya-desktop-input.pdb")
// Remove a prior candidate even if this build later fails or targets another platform.
rmSync(capture, { force: true })
rmSync(input, { force: true })
const repair = await load(join(root, "..", ".."), process.argv[3] ?? process.env.RAYA_REPAIR_BUILD_INPUT)
if ((mode === "repair") !== Boolean(repair))
  throw new Error("Repair packaging requires its captured build input and cannot install or release")
if (repair) {
  // The shared CLI builder treats any nonempty KILO_RELEASE as permission to upload release assets.
  delete process.env.KILO_RELEASE
  process.env.RAYA_REPAIR_BUILD_INPUT = resolve(process.argv[3] ?? process.env.RAYA_REPAIR_BUILD_INPUT!)
  process.env.KILO_VERSION = repair.cli
  process.env.KILO_CHANNEL = "repair"
}
const pkgPath = join(root, "package.json")

const pkg = await Bun.file(pkgPath).json()
const sha = repair ? repair.snapshot.head.slice(0, 12) : (await $`git rev-parse --short HEAD`.text()).trim()
const user =
  (repair ? "repair" : await $`git config --get --default local user.name`.text())
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "local"
const stamp = Date.now() // raya_change - unique local identity prevents stale VS Code webview service-worker state
// raya_change start - release mode takes its version from the pushed tag and its platform from the runner
const target = repair?.target ?? (process.env.RAYA_VSCE_TARGET?.trim() || undefined)
const packageTarget = target ?? `${process.platform}-${process.arch}`
// vsce requires a plain major.minor.patch version, so coerce off any prerelease/build suffix.
const releaseVersion = (process.env.RAYA_RELEASE_VERSION ?? "")
  .trim()
  .replace(/^raya-/, "")
  .replace(/^v/, "")
  .replace(/[-+].*$/, "")
if (isRelease && !/^\d+\.\d+\.\d+$/.test(releaseVersion))
  throw new Error(`release mode needs RAYA_RELEASE_VERSION as x.y.z (got "${process.env.RAYA_RELEASE_VERSION ?? ""}")`)
const snapshotVersion =
  repair?.extension ?? (isRelease ? releaseVersion : `${pkg.version}-snapshot+${sha}.${user}.${stamp}`)
// raya_change end

console.log(`Building ${isRelease ? "release" : "snapshot"} version: ${snapshotVersion}`)
console.log(`Base version: ${pkg.version}`)
console.log(`Commit: ${sha}`)
if (target) console.log(`Target: ${target}`)
console.log(`Mode: ${mode}\n`)

console.log("🧹 Cleaning build directories...")
const dist = join(root, "dist")
if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true })
  console.log("  ✓ Cleaned dist/")
}

const outDir = isRelease ? join(root, "out") : join(tmpdir(), "raya-vscode-snapshots") // raya_change - release assets land in out/
mkdirSync(outDir, { recursive: true })
// Clear deterministic release/repair output before any build step. A failed
// build must not leave yesterday's VSIX at the expected package path.
const vsixPath =
  repair?.output ??
  (isRelease
    ? join(outDir, `raya-${target ?? "universal"}.vsix`)
    : join(outDir, `raya-vscode-snapshot-${sha}-${user}-${stamp}.vsix`))
rmSync(vsixPath, { force: true })

console.log("\n📦 Preparing SDK...")
await $`bun run prepare:sdk`.cwd(root)

console.log("\n🔧 Preparing CLI binary and validating extension...")
await $`bun script/local-bin.ts --compiled`.cwd(root)
const low = process.env.RAYA_LOW_MEMORY === "1"
if (low) {
  console.log("  Running extension validation sequentially (low-memory mode)")
  for (const task of ["check-types", "check-types:webview", "lint", "bundle:production"])
    await $`bun run ${task}`.cwd(root)
}
if (!low) await $`bun run build:check:production`.cwd(root)
if (repair) {
  await load(join(root, "..", ".."))
  const binary = join(root, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
  const version = (await $`${binary} --version`.cwd(root).text()).trim()
  if (version !== repair.cli) throw new Error(`Repair CLI version mismatch: ${version}`)
  await Bun.write(join(dist, "raya-build.json"), JSON.stringify({ ...identity(repair), binary: await digest(binary) }))
}

// The candidate is intentionally limited to native Windows x64 builds. It is never
// copied from a prior package, cross-compiled implicitly, or included on ARM64.
const includeCapture = packageTarget === "win32-x64"
if (includeCapture) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Windows x64 desktop capture packaging requires a Windows x64 build host")
  console.log("\nBuilding and self-testing native desktop capture candidate...")
  await $`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${join(root, "script", "build-desktop-capture.ps1")} -Output ${capture}`.cwd(
    root,
  )
  if (!existsSync(capture)) throw new Error("Native desktop capture build did not produce its executable")
  if (!existsSync(symbols)) throw new Error("Native desktop capture build did not produce matching symbols")
  console.log("\nBuilding and self-testing native desktop input broker...")
  await $`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${join(root, "script", "build-desktop-input.ps1")} -Output ${input}`.cwd(
    root,
  )
  if (!existsSync(input)) throw new Error("Native desktop input build did not produce its executable")
  if (!existsSync(inputSymbols)) throw new Error("Native desktop input build did not produce matching symbols")
}

console.log("\n📦 Packaging VSIX...")
// raya_change - release VSIX names carry the platform target so VS Code installs the matching build
const require = createRequire(import.meta.url)
const vsceRequire = createRequire(require.resolve("@vscode/vsce"))
if (shouldInstall) {
  // Local installs favor fast packaging and extraction over archive size.
  type Options = Record<string, unknown>
  type Zip = {
    addFile(path: string, name: string, options?: Options): void
    addBuffer(data: Uint8Array, name: string, options?: Options): void
  }
  const yazl = vsceRequire("yazl") as { ZipFile: { prototype: Zip } }
  const zip = yazl.ZipFile.prototype
  const file = zip.addFile
  const buffer = zip.addBuffer
  zip.addFile = function (this: Zip, path, name, options) {
    return file.call(this, path, name, { ...options, compress: false })
  }
  zip.addBuffer = function (this: Zip, data, name, options) {
    return buffer.call(this, data, name, { ...options, compress: false })
  }
}
const { createVSIX } = await import("@vscode/vsce")
const dir = includeCapture ? mkdtempSync(join(tmpdir(), "raya-vsix-ignore-")) : undefined
try {
  const ignore = dir ? join(dir, ".vscodeignore") : undefined
  if (ignore) {
    const rules = [
      "bin/raya-desktop-capture.exe",
      "bin/raya-desktop-capture.pdb",
      "bin/raya-desktop-input.exe",
      "bin/raya-desktop-input.pdb",
    ]
    const source = readFileSync(join(root, ".vscodeignore"), "utf8")
    if (rules.some((rule) => !source.split(/\r?\n/).includes(rule)))
      throw new Error("Native capture default exclusion is missing")
    writeFileSync(
      ignore,
      rules.reduce((text, rule) => text.replace(rule, `!${rule}`), source),
    )
  }
  await createVSIX({
    cwd: root,
    packagePath: vsixPath,
    version: snapshotVersion,
    target: packageTarget, // raya_change - every retained package has an exact platform identity
    updatePackageJson: false,
    dependencies: false,
    skipLicense: true,
    ignoreFile: ignore,
  })
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true })
}
if (repair) await load(join(root, "..", ".."))

if (shouldInstall) {
  const execPath = process.env.VSCODE_EXEC_PATH ?? ""
  const isInsiders = execPath.toLowerCase().includes("insiders")
  const name = isInsiders ? "code-insiders" : "code"
  const winPath = process.platform === "win32" && execPath ? join(dirname(execPath), "bin", name + ".cmd") : ""
  const cli = winPath && existsSync(winPath) ? winPath : name
  const product = isInsiders ? "Code - Insiders" : "Code"
  const storage =
    process.env.RAYA_GLOBAL_STORAGE?.trim() ||
    (process.platform === "win32"
      ? join(
          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
          product,
          "User",
          "globalStorage",
          "eden.raya",
        )
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", product, "User", "globalStorage", "eden.raya")
        : join(
            process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
            product.toLowerCase(),
            "User",
            "globalStorage",
            "eden.raya",
          ))
  const vault = new PackageVault(join(storage, "package-vault"))
  const before = await vault.pruneSnapshots()
  const saved = await vault.retain(vsixPath, {
    name: "raya",
    publisher: "eden",
    version: snapshotVersion,
    target: packageTarget,
  })
  const after = await vault.pruneSnapshots({ keep: [saved.artifact.digest] })
  console.log(`\n🚀 Installing to ${cli}...`)
  await $`${cli} --force --install-extension ${vsixPath}`

  const extensions =
    process.env.VSCODE_EXTENSIONS?.trim() || join(homedir(), isInsiders ? ".vscode-insiders" : ".vscode", "extensions")
  const active = await (async () => {
    if (process.platform !== "win32") return []
    const script =
      "Get-Process -Name kilo -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { Split-Path (Split-Path $_.Path -Parent) -Parent } }"
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    })
    const output = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? output.split(/\r?\n/).filter(Boolean) : []
  })()
  const removed = await prune({ stage: outDir, extensions, version: snapshotVersion, active })

  console.log(`\n✅ Successfully installed snapshot extension!`)
  console.log(`   Version: ${snapshotVersion}`)
  console.log(`   Retained rollback package: ${saved.package}`)
  console.log(
    `   Removed old snapshots: ${before.packages + after.packages} vault package(s), ${removed.packages} staged package(s), ${removed.extensions} extension(s)`,
  )
}
