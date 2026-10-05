import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { hosted } from "./fixtures/source-memory-quarantine-assert"

test.skipIf(process.platform !== "win32" || !process.env.RAYA_TEST_DIRECTORY_HELPER)(
  "actual isolated hosted seed retires its own lifetime before Source capture",
  async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    for (const dir of ["workspace", "home", "data", "config", "cache", "state", "evidence"])
      await mkdir(path.join(root, dir))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
          !/(TOKEN|SECRET|API_KEY)$/.test(entry[0]),
      ),
    )
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      KILO_TEST_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      KILO_DB: ":memory:",
      RAYA_DB: ":memory:",
      KILO_DISABLE_MODELS_FETCH: "1",
      RAYA_DISABLE_MODELS_FETCH: "1",
    })
    const evidence = path.join(root, "evidence")
    const backups = await hosted(root, path.join(root, "workspace"), env, evidence)
    expect(backups).toHaveLength(2)
    expect(backups.map((entry) => entry.bytes)).toEqual([600001, 600041])
    const receipt = JSON.parse(await readFile(path.join(evidence, "hosted-memory-seed-receipt.json"), "utf8"))
    expect(receipt.naturalExitCode).toBe(0)
    expect(receipt.forced).toBe(false)
    expect(receipt.owner.pid).not.toBe(process.pid)
    assert.equal(receipt.profileClosed, true)
    assert.equal(receipt.shutdownJoined, true)
    assert(receipt.markers.length > 0)
    assert.deepEqual(receipt.after.roots, [])
  },
  40000,
)
