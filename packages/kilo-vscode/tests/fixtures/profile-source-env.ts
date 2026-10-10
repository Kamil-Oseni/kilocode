import { mkdir } from "node:fs/promises"
import path from "node:path"

/** Child-only paths and verified offline flags; inherited everyday overrides are removed. */
export async function environment(root: string, database = path.join(root, "selected.db")) {
  for (const name of ["home", "data", "config", "state", "cache", "temp"])
    await mkdir(path.join(root, name), { recursive: true })
  const home = path.join(root, "home")
  const drive = path.parse(home).root.replace(/[\\/]$/, "")
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(KILO_|RAYA_|OPENCODE_)/i.test(key)),
  )
  Object.assign(env, {
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    HOME: home,
    KILO_TEST_HOME: home,
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    KILO_TELEMETRY_LEVEL: "off",
  })
  const config = JSON.stringify({ experimental: { openTelemetry: false }, formatter: false, lsp: false })
  for (const [key, value] of Object.entries({
    DB: database,
    CONFIG_DIR: path.join(root, "config"),
    CONFIG_CONTENT: config,
    PURE: "1",
    DISABLE_DEFAULT_PLUGINS: "1",
    DISABLE_MODELS_FETCH: "1",
    DISABLE_AUTOUPDATE: "1",
    DISABLE_LSP_DOWNLOAD: "1",
    DISABLE_EXTERNAL_SKILLS: "1",
  })) {
    env[`RAYA_${key}`] = value
    env[`KILO_${key}`] = value
  }
  return env
}
