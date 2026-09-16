import { existsSync } from "fs"
import * as os from "os"
import * as path from "path"

export type Scope = "global" | "local"

export type Source =
  | "sourceXdg"
  | "sourceHomeKilo"
  | "sourceHomeKilocode"
  | "sourceHomeOpencode"
  | "sourceEnvFile"
  | "sourceEnvDir"
  | "sourceEnvContent"
  | "sourceProjectKilo"
  | "sourceProjectRoot"
  | "sourceProjectKilocode"
  | "sourceProjectOpencode"

export interface Entry {
  file?: string
  name: string
  source: Source
  exists: boolean
  loaded: boolean
  legacy?: boolean
  recommended?: boolean
  virtual?: boolean
}

const SCHEMA = "https://app.kilo.ai/config.json"

const MODERN = ["kilo.jsonc", "kilo.json"]
const LEGACY = ["opencode.jsonc", "opencode.json"]
const FILES = [...MODERN, ...LEGACY]
const GLOBAL = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json", "config.json"]
const HOME = [".kilo", ".kilocode", ".opencode"]
const SOURCES: Record<string, Source> = {
  ".kilo": "sourceHomeKilo",
  ".kilocode": "sourceHomeKilocode",
  ".opencode": "sourceHomeOpencode",
}

function env(raya: string, kilo: string) {
  const value = process.env[raya]
  if (value !== undefined) return value
  return process.env[kilo]
}

function row(file: string, source: Source, loaded = true, recommended = false): Entry {
  const name = path.basename(file)
  return {
    file,
    name,
    source,
    exists: existsSync(file),
    loaded: loaded && existsSync(file),
    legacy: name.startsWith("opencode") || name === "config.json" || file.includes(`${path.sep}.kilocode${path.sep}`),
    recommended,
  }
}

function ensure(list: Entry[], file: string, source: Source) {
  if (list.some((item) => item.file === file)) return list
  return [...list, row(file, source, true, true)]
}

export function globalFiles() {
  const root = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "kilo")
  const base = GLOBAL.map((file) => row(path.join(root, file), "sourceXdg")).filter((item) => item.exists)
  const dirs = HOME.flatMap((dir) => {
    const base = path.join(os.homedir(), dir)
    if (!existsSync(base)) return []
    return FILES.map((file) => row(path.join(base, file), SOURCES[dir])).filter((item) => item.exists)
  })
  const config = env("RAYA_CONFIG", "KILO_CONFIG")
  const envfile = config ? [row(config, "sourceEnvFile")] : []
  const extra = env("RAYA_CONFIG_DIR", "KILO_CONFIG_DIR")
  const dir = extra
    ? ensure(
        FILES.map((file) => row(path.join(extra, file), "sourceEnvDir")).filter((item) => item.exists),
        path.join(extra, "kilo.jsonc"),
        "sourceEnvDir",
      )
    : []
  const body = env("RAYA_CONFIG_CONTENT", "KILO_CONFIG_CONTENT")
  const virtual: Entry[] = body
    ? [
        {
          name: process.env.RAYA_CONFIG_CONTENT !== undefined ? "RAYA_CONFIG_CONTENT" : "KILO_CONFIG_CONTENT",
          source: "sourceEnvContent",
          exists: true,
          loaded: true,
          virtual: true,
        },
      ]
    : []

  return ensure([...base, ...dirs, ...envfile, ...dir, ...virtual], path.join(root, "kilo.jsonc"), "sourceXdg")
}

export function localFiles(root: string) {
  const enabled = !process.env.KILO_DISABLE_PROJECT_CONFIG
  const dirs = [path.join(root, ".kilo"), root, path.join(root, ".kilocode"), path.join(root, ".opencode")]
  const list = dirs.flatMap((dir) => FILES.map((file) => row(path.join(dir, file), localSource(root, dir), enabled)))
  return ensure(
    list.filter((item) => item.exists),
    path.join(root, ".kilo", "kilo.jsonc"),
    "sourceProjectKilo",
  ).map((item) => (enabled ? item : { ...item, loaded: false }))
}

function localSource(root: string, dir: string) {
  if (dir === root) return "sourceProjectRoot"
  if (dir.endsWith(`${path.sep}.kilo`)) return "sourceProjectKilo"
  if (dir.endsWith(`${path.sep}.kilocode`)) return "sourceProjectKilocode"
  return "sourceProjectOpencode"
}

export function content() {
  return `{
  "$schema": "${SCHEMA}"
}
`
}
