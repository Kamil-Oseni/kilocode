import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ripgrep } from "../../../src/kilocode/ripgrep-owner"
import { RuntimeRegistry } from "../../../src/kilocode/runtime-registry"
import { closeProcessProfile } from "../../../src/kilocode/process-profile"

const root = process.argv[2]
assert.ok(root && path.isAbsolute(root))
await Effect.runPromise(
  ripgrep.run(
    () => root,
    (dir) =>
      Effect.promise(async () => {
        const file = path.join(dir, "count")
        const before = Number(await readFile(file, "utf8"))
        await Bun.sleep(100)
        await writeFile(file, String(before + 1))
      }),
  ),
)
await RuntimeRegistry.drain()
assert.equal(ripgrep.snapshot().active, 0)
await closeProcessProfile()
