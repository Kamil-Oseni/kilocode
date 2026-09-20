import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

const root = resolve(import.meta.dir, "..")
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
  const result = join(profile, `${name}.json`)
  const electron = process.env.ELECTRON_RUN_AS_NODE
  delete process.env.ELECTRON_RUN_AS_NODE
  try {
    const code = spawn(
      vscode,
      [
        workspace,
        `--user-data-dir=${profile}`,
        `--extensions-dir=${join(profile, "extensions")}`,
        `--shared-data-dir=${join(profile, "shared")}`,
        `--extensionDevelopmentPath=${extension}`,
        "--new-window",
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        "--disable-telemetry",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
        RAYA_UPDATE_SECRET_ACCEPTANCE: "1",
        RAYA_UPDATE_SECRET_PHASE: name,
        RAYA_UPDATE_SECRET_TOKEN: token,
          RAYA_UPDATE_SECRET_RESULT: result,
        },
      },
    )
    const exit = await new Promise<number | null>((resolve, reject) => {
      code.once("error", reject)
      code.once("exit", resolve)
    })
    if (exit !== 0) throw new Error(`VS Code update credential acceptance exited with ${exit}`)
    return JSON.parse(await readFile(result, "utf8")) as unknown
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
    const stored = await phase("store", extension, workspace, profile, token)
    if (JSON.stringify(stored) !== JSON.stringify({ saved: true })) throw new Error("SecretStorage store failed")
    const cleared = await phase("read-clear", extension, workspace, profile, token)
    if (JSON.stringify(cleared) !== JSON.stringify({ saved: true, cleared: true }))
      throw new Error("SecretStorage restart verification failed")
    console.log(`Installed SecretStorage acceptance passed: ${basename(extension)}`)
  } finally {
    await clean(temp)
  }
}

await main()
