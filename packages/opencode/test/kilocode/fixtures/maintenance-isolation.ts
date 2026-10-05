import assert from "node:assert/strict"
import { maintenance } from "../../../src/kilocode/migration/maintenance-entry"

assert.equal(
  Object.keys(process.env).some(
    (key) => key.startsWith("RAYA_DAEMON_") || /^RAYA_(?:SOURCE|CONTROLLER|HOST|PARENT)_/.test(key),
  ),
  false,
)
await maintenance()
