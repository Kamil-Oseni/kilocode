#!/usr/bin/env bun
// raya_change - Raya snapshot artifact identity
import { $ } from "bun"
import { createRequire } from "node:module"
import { join, dirname, resolve } from "node:path"
import { tmpdir } from "node:os"
import { rmSync, mkdirSync, existsSync } from "node:fs"
import { load, identity, digest } from "../../opencode/src/kilocode/self-heal/build-input"

const mode = process.argv[2] ?? "install"
const shouldInstall = mode === "install"
// raya_change - "release" builds a versioned, platform-targeted VSIX into out/ for a GitHub Release
const isRelease = mode === "release"

const root = join(import.meta.dir, "..")
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

console.log("\n📦 Preparing SDK...")
await $`bun run prepare:sdk`.cwd(root)

console.log("\n🔧 Preparing CLI binary and validating extension...")
await $`bun script/local-bin.ts --compiled`.cwd(root)
await $`bun run build:check:production`.cwd(root)
if (repair) {
  await load(join(root, "..", ".."))
  const binary = join(root, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
  const version = (await $`${binary} --version`.cwd(root).text()).trim()
  if (version !== repair.cli) throw new Error(`Repair CLI version mismatch: ${version}`)
  await Bun.write(join(dist, "raya-build.json"), JSON.stringify({ ...identity(repair), binary: await digest(binary) }))
}

console.log("\n📦 Packaging VSIX...")
// raya_change - release VSIX names carry the platform target so VS Code installs the matching build
const vsixPath =
  repair?.output ??
  (isRelease
    ? join(outDir, `raya-${target ?? "universal"}.vsix`)
    : join(outDir, `raya-vscode-snapshot-${sha}-${user}-${stamp}.vsix`))
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
await createVSIX({
  cwd: root,
  packagePath: vsixPath,
  version: snapshotVersion,
  ...(target ? { target } : {}), // raya_change - platform-tagged VSIX for GitHub Release assets
  updatePackageJson: false,
  dependencies: false,
  skipLicense: true,
})
if (repair) await load(join(root, "..", ".."))

if (shouldInstall) {
  const execPath = process.env.VSCODE_EXEC_PATH ?? ""
  const isInsiders = execPath.toLowerCase().includes("insiders")
  const name = isInsiders ? "code-insiders" : "code"
  const winPath = process.platform === "win32" && execPath ? join(dirname(execPath), "bin", name + ".cmd") : ""
  const cli = winPath && existsSync(winPath) ? winPath : name
  console.log(`\n🚀 Installing to ${cli}...`)
  await $`${cli} --force --install-extension ${vsixPath}`

  console.log(`\n✅ Successfully installed snapshot extension!`)
  console.log(`   Version: ${snapshotVersion}`)
}
