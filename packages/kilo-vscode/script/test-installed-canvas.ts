// raya_change - EN-06 installed snapshot restart/recovery acceptance
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { runTests } from "@vscode/test-electron"

const packageRoot = resolve(import.meta.dir, "..")
const runner = join(packageRoot, "tests", "installed", "canvas")
const vscode = join(packageRoot, ".vscode-test", "vscode-win32-x64-archive-1.134.0", "Code.exe")

function saved(name: string, value: number) {
  const revision = randomUUID()
  const source = `export default function Canvas() { return <main>${name}</main> }`
  const data = { value }
  return {
    source,
    code: `window.RayaCanvas.mount(function Canvas(){return window.RayaCanvas.React.createElement("main",null,${JSON.stringify(name)})});`,
    build: { name, revision, status: "ready" as const, version: 1, data },
  }
}

async function extensions() {
  const home = process.env.USERPROFILE
  if (!home) throw new Error("USERPROFILE is required to locate the installed Raya snapshot")
  const root = join(home, ".vscode", "extensions")
  const names = (await readdir(root)).filter((name) => name.startsWith("eden.raya-"))
  const items = await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(root, name))).mtimeMs })))
  return items.sort((a, b) => b.time - a.time).map((item) => join(root, item.name))
}

async function fixture(root: string, cache: string, name: string, value: number) {
  const record = saved(name, value)
  const dir = join(root, ".raya", "canvases")
  await mkdir(dir, { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(join(dir, `${name}.canvas.tsx`), record.source)
  await writeFile(join(dir, `${name}.canvas.json`), JSON.stringify(record.build.data, null, 2))
  await writeFile(join(cache, `${name}.current.json`), JSON.stringify(record))
  await writeFile(join(cache, `${name}.recovery.json`), JSON.stringify(record))
  return record
}

async function phase(
  name: "matrix" | "crash" | "recover",
  extension: string,
  root: string,
  profile: string,
  cache: string,
  marker: string,
) {
  return runTests({
    vscodeExecutablePath: vscode,
    extensionDevelopmentPath: extension,
    extensionTestsPath: runner,
    launchArgs: [
      root,
      `--user-data-dir=${profile}`,
      `--extensions-dir=${join(profile, "extensions")}`,
      "--disable-telemetry",
    ],
    extensionTestsEnv: {
      RAYA_CANVAS_PHASE: name,
      RAYA_CANVAS_ROOT: root,
      RAYA_CANVAS_CACHE: cache,
      RAYA_CANVAS_MARKER: marker,
    },
  })
}

async function main() {
  if (process.platform !== "win32") throw new Error("Installed Canvas acceptance currently targets the Windows package")
  const candidates = await extensions()
  const extension = process.env.RAYA_INSTALLED_EXTENSION ?? candidates[0]
  if (!extension) throw new Error("No installed eden.raya snapshot was found")
  const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8")) as { version?: string }
  if (!manifest.version?.includes("snapshot+"))
    throw new Error(`${basename(extension)} is not an installed snapshot build`)

  const temp = await mkdtemp(join(tmpdir(), "raya-canvas-installed-"))
  const root = join(temp, "workspace")
  const profile = join(temp, "profile")
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  const cache = join(profile, "User", "globalStorage", "eden.raya", "canvas-bundles", hash)
  const marker = join(temp, "crash-receipt.txt")
  await mkdir(root, { recursive: true })
  await Promise.all([
    fixture(root, cache, "valid", 1),
    fixture(root, cache, "damaged", 2),
    fixture(root, cache, "divergent", 3),
    fixture(root, cache, "dual", 4),
    fixture(root, cache, "crash", 5),
  ])
  await writeFile(join(cache, "damaged.current.json"), "{damaged-current")
  await writeFile(join(cache, "dual.current.json"), "{damaged-current")
  await writeFile(join(cache, "dual.recovery.json"), "{damaged-recovery")
  await writeFile(join(root, ".raya", "canvases", "divergent.canvas.json"), JSON.stringify({ value: 99 }, null, 2))

  try {
    await phase("matrix", extension, root, profile, cache, marker)
    try {
      await phase("crash", extension, root, profile, cache, marker)
      throw new Error("Crash phase unexpectedly exited cleanly")
    } catch (error) {
      if (!(await Bun.file(marker).exists())) throw error
    }
    if (!(await Bun.file(join(cache, "crash.transaction.json")).exists()))
      throw new Error("The interrupted Canvas transaction was not retained after extension-host termination")
    await phase("recover", extension, root, profile, cache, marker)
    console.log(`Installed Canvas acceptance passed: ${basename(extension)}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

await main()
