import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { runTests } from "@vscode/test-electron"

const root = resolve(import.meta.dir, "..")
const runner = join(root, "tests", "installed", "update-secret", "index.cjs")
const vscode = join(root, ".vscode-test", "vscode-win32-x64-archive-1.134.0", "Code.exe")

async function extensions() {
  const home = process.env.USERPROFILE
  if (!home) throw new Error("USERPROFILE is required to locate the installed Raya snapshot")
  const dir = join(home, ".vscode", "extensions")
  const names = (await readdir(dir)).filter((name) => name.startsWith("eden.raya-"))
  const items = await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(dir, name))).mtimeMs })))
  return items.sort((a, b) => b.time - a.time).map((item) => join(dir, item.name))
}

async function phase(
  name: "store" | "read-clear",
  extension: string,
  workspace: string,
  profile: string,
  token: string,
) {
  const electron = process.env.ELECTRON_RUN_AS_NODE
  delete process.env.ELECTRON_RUN_AS_NODE
  try {
    await runTests({
      vscodeExecutablePath: vscode,
      extensionDevelopmentPath: extension,
      extensionTestsPath: runner,
      launchArgs: [
        workspace,
        `--user-data-dir=${profile}`,
        `--extensions-dir=${join(profile, "extensions")}`,
        "--disable-telemetry",
      ],
      extensionTestsEnv: {
        RAYA_UPDATE_SECRET_ACCEPTANCE: "1",
        RAYA_UPDATE_SECRET_PHASE: name,
        RAYA_UPDATE_SECRET_TOKEN: token,
      },
    })
  } finally {
    if (electron === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = electron
  }
}

async function clean(path: string) {
  const base = resolve(tmpdir())
  const target = resolve(path)
  if (!target.startsWith(`${base}${sep}`))
    throw new Error(`Refusing to remove update test path outside temp: ${target}`)
  await rm(target, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 })
}

async function main() {
  if (process.platform !== "win32") throw new Error("Installed update credential acceptance currently targets Windows")
  const candidates = await extensions()
  const extension = process.env.RAYA_INSTALLED_EXTENSION ?? candidates[0]
  if (!extension) throw new Error("No installed eden.raya snapshot was found")
  const temp = await mkdtemp(join(tmpdir(), "raya-update-secret-installed-"))
  const workspace = join(temp, "workspace")
  const profile = join(temp, "profile")
  const token = randomBytes(24).toString("base64url")
  try {
    await mkdir(workspace, { recursive: true })
    await phase("store", extension, workspace, profile, token)
    await phase("read-clear", extension, workspace, profile, token)
    console.log(`Installed SecretStorage acceptance passed: ${basename(extension)}`)
  } finally {
    await clean(temp)
  }
}

await main()
