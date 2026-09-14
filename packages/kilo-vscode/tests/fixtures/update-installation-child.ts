import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { Installation, type InstallRequest } from "../../src/services/update-installation"

const root = process.argv[2]
const log = process.argv[3]
const mode = process.argv[4]
if (!root || !log || !["complete", "fail"].includes(mode)) throw new Error("Invalid child process arguments.")

const digest = "a".repeat(64)
const input: InstallRequest = {
  schema: 2,
  version: "1.2.3",
  previous: "1.2.2",
  repo: "eden/raya",
  target: "win32-x64",
  asset: {
    name: "raya-win32-x64.vsix",
    url: "https://api.github.com/repos/eden/raya/releases/assets/123",
    size: 42,
    digest: `sha256:${digest}`,
  },
  artifact: { digest, size: 42 },
  package: join(root, `raya.${digest}.vsix`),
}
const state = { get: () => undefined, update: async () => undefined }

await new Installation(state, root)
  .run(input, async () => {
    await appendFile(log, `${process.pid}\n`)
    await Bun.sleep(150)
    if (mode === "fail") throw new Error("installer acknowledgement lost")
  })
  .then((result) => console.log(JSON.stringify({ dispatched: result.dispatched, phase: result.record.phase })))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 2
  })
