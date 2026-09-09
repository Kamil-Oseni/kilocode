import path from "path"
import "./kilocode/isolate" // kilocode_change - isolate filesystem state before runtime imports

process.env.KILO_DB = ":memory:"
process.env.KILO_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.KILO_DISABLE_MODELS_FETCH = "true"

// kilocode_change start - fail closed: isolate filesystem state and verify KILO_DB
// keeps default connections off the real user database. Verify the
// resolved path (env is read at flag import time, so this must stay after the env writes).
const { Database } = await import("../src/database/database")
const resolved = Database.path()
if (resolved !== ":memory:") {
  throw new Error(`unit test preload: database path must resolve to ":memory:", got "${resolved}"`)
}
// kilocode_change end
