import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
const root = process.argv[2]
assert.deepEqual(ProfileRoots.snapshot(), [])
await import("../../../src/kilocode/migration/profile-storage-correspondence")
assert.deepEqual(ProfileRoots.snapshot(), [])
assert.deepEqual(await readdir(root), [])
const [{ SessionV2 }, ids, task, goal, checkpoint, schemas] = await Promise.all([
  import("@opencode-ai/core/session"),
  import("../../../src/session/schema"),
  import("../../../src/kilocode/task"),
  import("../../../src/kilocode/goal"),
  import("../../../src/kilocode/checkpoint"),
  Promise.all([
    import("../../../src/kilocode/task/schema"),
    import("../../../src/kilocode/goal/schema"),
    import("../../../src/kilocode/checkpoint/schema"),
  ]),
])
assert.equal(ids.SessionID, SessionV2.ID)
assert.equal(task.RayaTask.Agent, schemas[0].Codec.Agent)
assert.equal(task.RayaTask.History, schemas[0].Codec.History)
assert.equal(goal.RayaGoal.State, schemas[1].Codec.State)
assert.equal(checkpoint.RayaCheckpoint.List, schemas[2].Codec.List)
console.log("STORAGE_SCHEMA_IMPORT_OK")
await (await import("../../../src/kilocode/cli/finish")).finish([])
