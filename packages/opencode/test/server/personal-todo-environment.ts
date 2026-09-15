// kilocode_change - new file
import path from "node:path"
import os from "node:os"
import { rm } from "node:fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"

export const root = path.join(os.tmpdir(), `raya-personal-todo-http-${process.pid}`)

process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.KILO_DB = ":memory:"
process.env.KILO_DISABLE_SHARE = "true"
process.env.KILO_DISABLE_SESSION_INGEST = "true"
process.env.KILO_DISABLE_PRESENCE = "1"
process.env.KILO_DISABLE_CODEBASE_INDEXING = "vscode-no-workspace"
Flag.KILO_DB = ":memory:"

export const cleanup = () => rm(root, { recursive: true, force: true })
