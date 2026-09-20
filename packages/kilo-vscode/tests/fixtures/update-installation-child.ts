import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { Installation, type InstallRequest } from "../../src/services/update-installation"
import { inspect } from "../../src/services/update-vsix"

const root = process.argv[2]
const log = process.argv[3]
const mode = process.argv[4]
const source = process.argv[5]
if (!root || !log || !source || !["complete", "fail", "rollback-complete", "rollback-fail"].includes(mode))
  throw new Error("Invalid child process arguments.")

const digest = "a".repeat(64)
const target = `${process.platform}-${process.arch}`
const rollback = await inspect(source, { name: "raya", publisher: "eden", version: "1.2.2", target })
const input: InstallRequest = {
  schema: 3,
  version: "1.2.3",
  previous: "1.2.2",
  repo: "eden/raya",
  target,
  asset: {
    name: "raya-win32-x64.vsix",
    url: "https://api.github.com/repos/eden/raya/releases/assets/123",
    size: 42,
    digest: `sha256:${digest}`,
  },
  artifact: { digest, size: 42 },
  binary: { digest: "b".repeat(64), size: 22 },
  package: join(root, `raya.${digest}.vsix`),
  rollback: {
    version: "1.2.2",
    target,
    package: source,
    artifact: rollback.artifact,
    binary: rollback.binary,
  },
}
const state = { get: () => undefined, update: async () => undefined }

const journal = new Installation(state, root)
const operation = mode.startsWith("rollback-") ? journal.rollback.bind(journal) : journal.run.bind(journal, input)
await operation(async () => {
  await appendFile(log, `${process.pid}\n`)
  await Bun.sleep(150)
  if (mode.endsWith("fail")) throw new Error("installer acknowledgement lost")
})
  .then((result) => console.log(JSON.stringify({ dispatched: result.dispatched, phase: result.record.phase })))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 2
  })
