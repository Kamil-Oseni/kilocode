import { afterAll } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

// Import before any runtime modules: xdg-basedir captures its environment at import time.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-test-state-"))
process.env.XDG_DATA_HOME = path.join(dir, "data")
process.env.XDG_STATE_HOME = path.join(dir, "state")
process.env.XDG_CACHE_HOME = path.join(dir, "cache")
process.env.XDG_CONFIG_HOME = path.join(dir, "config")
process.env.KILO_TEST_HOME = path.join(dir, "home")
process.env.KILO_DB = ":memory:"
process.env.KILO_DISABLE_MODELS_FETCH = "true"
await fs.mkdir(process.env.KILO_TEST_HOME, { recursive: true })

afterAll(async () => {
  for (const attempt of Array.from({ length: 30 }, (_, index) => index)) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (!err || typeof err !== "object" || !("code" in err) || err.code !== "EBUSY" || attempt === 29) throw err
      Bun.gc(true)
      await Bun.sleep(100)
    }
  }
})
