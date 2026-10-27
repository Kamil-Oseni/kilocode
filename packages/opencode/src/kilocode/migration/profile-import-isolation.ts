import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Call before loading any lazy Global dependency in an isolated import or inspection process. */
export async function isolate() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-profile-import-"))
  for (const name of Object.keys(process.env))
    if (/^(?:OTEL_|RAYA_|KILO_|OPENCODE_)|(?:API_KEY|TOKEN|SECRET)$/.test(name)) delete process.env[name]
  Object.assign(process.env, {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    KILO_TEST_HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"),
    APPDATA: path.join(root, "roaming"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    RAYA_DB: path.join(root, "unused.db"),
    KILO_DB: path.join(root, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_PURE: "1",
  })
  return root
}
