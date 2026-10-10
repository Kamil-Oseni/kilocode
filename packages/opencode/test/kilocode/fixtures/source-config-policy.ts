import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { prepare } from "@opencode-ai/core/kilocode/source-profile"
import { covers } from "@opencode-ai/core/kilocode/source-policy"
import { closeProcessProfile, processProfileSnapshot } from "@opencode-ai/core/kilocode/process-profile"
import { ConfigPublication } from "../../../src/kilocode/config/publication"

const root = process.argv[2]
assert(root && path.isAbsolute(root))
const account = path.join(root, "account")
const home = path.join(root, "home")
const cwd = path.join(root, "workspace")
await Promise.all([account, home, cwd].map((file) => mkdir(file)))
const prepared = await prepare({ account, home, cwd, env: { KILO_TEST_HOME: home } })
const file = path.join(home, ".config", "kilo", "owned.json")
await mkdir(path.dirname(file), { recursive: true })
await writeFile(file, "{}")
await ConfigPublication.using(account, () =>
  ConfigPublication.promise({ files: [file] }, async (tx) => {
    assert.equal(await tx.read(file), "{}")
    await tx.write(file, "{}", '{"owned":true}')
    await tx.check()
  }),
)
assert.equal(await readFile(file, "utf8"), '{"owned":true}')
const observed = processProfileSnapshot()
assert(observed.roots.some((file) => path.resolve(file) === path.join(account, ".raya-config-rmw-locks")))
assert(observed.roots.every((file) => covers(prepared.policy, file)))
assert(!covers(prepared.policy, account))
await ConfigPublication.drain()
await closeProcessProfile()
assert.equal(processProfileSnapshot().terminal, true)
assert.equal(processProfileSnapshot().failures, 0)
process.stdout.write(
  JSON.stringify({
    policy: prepared.policy,
    observed: observed.roots,
    terminal: true,
    portableCaptureAuthorized: false,
  }),
)
