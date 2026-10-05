import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { ConfigIntent } from "../../../src/kilocode/config-intent"
import { Global } from "../../../src/global"
import { closeProcessProfile, processProfileSnapshot, sourceScopes } from "../../../src/kilocode/process-profile"
import { ProfileRoots } from "../../../src/kilocode/profile-roots"
import { coordinateNativeRoots } from "../../../src/kilocode/profile-maintenance"

const root = process.argv[2]
const file = path.join(root, "workspace", "kilo.jsonc")
const text = await readFile(file, "utf8")
const token = ConfigIntent.graph("v2", Global.Path, path.dirname(file))
const object = {}
const pending = ConfigIntent.loaded(token, object, file, text).then(() => ConfigIntent.ordered(token, [object]))
assert(processProfileSnapshot().roots.includes(file))
assert.throws(() => ConfigIntent.snapshot(), /closure is incomplete/)
const closed = closeProcessProfile()
assert.throws(() => ConfigIntent.graph("v2", Global.Path), /terminal/)
await pending
await closed
const scopes = sourceScopes()
assert.equal(scopes.version, 4)
assert(scopes.version === 4)
assert.equal(scopes.configs.length, 1)
assert.equal(scopes.configs[0].documents[0].path, file)
assert.equal(scopes.configs[0].documents[0].safe.model, "provider/project")
assert(Object.isFrozen(scopes.configs[0].documents[0].identity))
assert.equal(processProfileSnapshot().roots.length, 0)
const result = await coordinateNativeRoots([{ kind: "json", path: file }], async (admission) => admission)
assert.equal(result.admission.operations, 0)
assert.equal(result.admission.nativeOwners, 0)
const before = ProfileRoots.snapshot()
await ConfigIntent.loaded(token, {}, path.join(root, "never-admitted.json"), "{}")
assert.deepEqual(ProfileRoots.snapshot(), before)
assert.throws(() => ConfigIntent.snapshot(), /uncertain/)
assert.equal(await readFile(file, "utf8"), text)
console.log("CONFIG_INTENT_PASS")
