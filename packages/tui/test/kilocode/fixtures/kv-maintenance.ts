import { existsSync, watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Hash } from "@opencode-ai/core/util/hash"
import {
  coordinateProfileWriters,
  profileScope,
  resolveProfileRoot,
} from "@opencode-ai/core/kilocode/profile-maintenance"

const dir = process.argv[2]
const state = path.join(dir, "state")
const root = await resolveProfileRoot({ kind: "json", path: state })
const locks = path.join(dir, ".raya-profile-locks")
await mkdir(locks, { recursive: true })
const gate = path.join(locks, `${Hash.fast(root.id)}.lock`)
const release = Promise.withResolvers<void>()
process.on("message", (message) => {
  if (message === "release") release.resolve()
})
const watcher = watch(locks, () => {
  if (!existsSync(gate)) return
  process.send?.("gated")
})
try {
  const scope = await profileScope({ data: dir, storage: state, channel: "test", disabled: true })
  const receipt = await coordinateProfileWriters(
    scope,
    "cooperative-maintenance",
    async () => {
      process.send?.("entered")
      await release.promise
      return "Private KV root only; no portable capture claim"
    },
    { timeoutMs: 10_000 },
  )
  console.log(JSON.stringify(receipt))
} finally {
  watcher.close()
  process.disconnect?.()
}
