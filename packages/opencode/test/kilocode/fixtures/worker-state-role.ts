import path from "node:path"
import { mkdir } from "node:fs/promises"
import * as Global from "@opencode-ai/core/global"
import { kvOwner } from "../../../../tui/src/kilocode/kv-owner"

const state = process.env.RAYA_ROLE_STATE!
await mkdir(state, { recursive: true })
Global.make({ state })
const owner = kvOwner(path.join(state, "kv.json"))
await owner.write({ animations_enabled: true, skipped_version: "worker-role-nonce" })
await owner.retire()
const mode = process.env.RAYA_ROLE_MODE
if (mode === "tui") await import("../../../src/cli/tui/worker")
if (mode === "export") await import("../../../src/kilocode/session-export/worker")
if (mode === "index") await import("../../../src/kilocode/indexing-worker")
postMessage({ roleReady: true })
