import assert from "node:assert/strict"
import path from "node:path"
import { open } from "node:fs/promises"
import { Global } from "../../../src/global"
import { closeProcessProfile, processProfileSnapshot, sourceScopes } from "../../../src/kilocode/process-profile"
import { scopePaths } from "../../../src/kilocode/source-scopes"
import { coordinateNativeRoots } from "../../../src/kilocode/profile-maintenance"
import { ProfileRoots } from "../../../src/kilocode/profile-roots"

const root = process.env.RAYA_PROCESS_PROFILE_ROOT
if (!root) throw new Error("Missing isolated lifetime fixture")
const baseline = processProfileSnapshot()
assert.ok(baseline.roots.length > 0)
const injected = Global.make({
  data: path.join(root, "injected", "data"),
  config: path.join(root, "injected", "config"),
  state: path.join(root, "injected", "state"),
  cache: path.join(root, "injected", "cache"),
  log: path.join(root, "injected", "log"),
  bin: path.join(root, "injected", "bin"),
  repos: path.join(root, "injected", "repos"),
  home: root,
})
assert.ok(processProfileSnapshot().roots.includes(injected.data))
const second = Global.make({
  ...injected,
  data: path.join(root, "second", "data"),
  config: path.join(root, "second", "config"),
  home: path.join(root, "second", "home"),
})
const scopes = sourceScopes()
assert.equal(scopes.version, 4)
if (scopes.version !== 4) throw new Error("Missing current namespace and configuration scope protocol")
// Current realized Global-only graphs carry explicit v4 configuration closure, without parsed config origins.
assert.equal(scopes.configStatus, "complete")
assert.equal(scopes.configReason, undefined)
assert.deepEqual(scopes.configs, [])
assert.ok(scopes.globals.some((roles) => roles.data === injected.data && roles.config === injected.config))
assert.ok(
  scopes.globals.some(
    (roles) => roles.data === second.data && roles.homeKilocode === path.join(second.home, ".kilocode"),
  ),
)
assert.ok(scopePaths(scopes).paths.every((file) => processProfileSnapshot().roots.includes(file)))
const selected = ProfileRoots.snapshot()
await assert.rejects(
  coordinateNativeRoots(selected, async () => undefined),
  /remain live/,
)
const file = await open(path.join(Global.Path.data, "native-before-close"), "w")
await file.write("actual bytes")
await file.close()
const closed = closeProcessProfile()
assert.equal(closeProcessProfile(), closed)
await closed
assert.deepEqual(sourceScopes(), scopes)
assert.equal(processProfileSnapshot().roots.length, 0)
assert.throws(() => Global.make(), /terminal/)
await coordinateNativeRoots(selected, async (admission) => {
  assert.equal(admission.nativeOwners, 0)
  assert.equal(admission.operations, 0)
  assert.throws(() => Global.make({ data: injected.data }), /terminal/)
})
await Bun.write(
  path.join(root, "receipt.json"),
  JSON.stringify({
    passed: true,
    scopeVersion: scopes.version,
    configStatus: scopes.configStatus,
    configCount: scopes.configs.length,
    initial: baseline.roots.length,
    union: selected.length,
    active: 0,
    lateRefused: true,
    portableCaptureAuthorized: false,
    globals: scopes.globals.length,
    roles: Object.keys(scopes.globals[0]).length,
  }),
)
