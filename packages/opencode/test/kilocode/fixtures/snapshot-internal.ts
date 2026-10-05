import assert from "node:assert/strict"
import path from "node:path"
import { Effect } from "effect"
import fs from "node:fs/promises"
import { acquireProfileRoot, registerProfileFile } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Snapshot } from "../../../src/snapshot"
import { provideTestInstance, disposeTestRuntime } from "../../fixture/fixture"

const root = process.env.KILO_TEST_HOME!
const file = path.join(Global.Path.data, "private.txt")
const sibling = path.join(path.dirname(Global.Path.data), "kilobook", "keep.txt")
await Bun.write(path.join(root, "work.txt"), "User work")
await Bun.write(file, "Runtime original")
await Bun.write(sibling, "Sibling user work")
await Bun.write(path.join(root, ".raya-profile-locks-user", "keep.txt"), "User sibling")
const target = path.join(root, "coordination", "state.json")
await Bun.write(target, "Live state")
const lease = await acquireProfileRoot({ kind: "json", path: target })
const owner = registerProfileFile({ kind: "json", path: target })
const metadata = path.join(path.dirname(target), ".raya-profile-locks")
const foreign = path.join(root, "unregistered", ".raya-profile-locks", "legacy.json")
await Bun.write(foreign, "Reserved legacy metadata")
const records = await fs.readdir(metadata, { recursive: true })
const markers = (
  await Promise.all(
    records.map(async (name) => {
      const file = path.join(metadata, name)
      return (await fs.lstat(file)).isFile() ? { file, bytes: await fs.readFile(file) } : undefined
    }),
  )
).filter((item) => item !== undefined)
assert.ok(markers.length >= 2, "Actual lease and native-owner records must be present")
try {
  await provideTestInstance({
    directory: root,
    fn: () =>
      Effect.runPromise(
        Snapshot.Service.use((snapshot) =>
          Effect.gen(function* () {
            const before = yield* snapshot.track()
            assert.ok(before)
            const gitdir = path.join(Global.Path.data, "snapshot", "global", Hash.fast(root))
            const git = async (args: string[]) => {
              const proc = Bun.spawn(["git", "--git-dir", gitdir, "--work-tree", root, ...args], {
                cwd: root,
                windowsHide: true,
                stdout: "pipe",
                stderr: "pipe",
              })
              const [out, err, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ])
              assert.equal(code, 0, err)
              return out.trim()
            }
            const files = yield* Effect.promise(() => git(["ls-tree", "-r", "--name-only", before]))
            assert.ok(files.includes("work.txt"))
            assert.ok(files.includes("kilobook/keep.txt"))
            assert.ok(!files.includes("kilo/private.txt"))
            assert.ok(!files.includes("/snapshot/"))
            assert.ok(files.includes(".raya-profile-locks-user/keep.txt"))
            assert.ok(!files.includes(".raya-profile-locks/"))
            for (const marker of markers) yield* Effect.promise(() => git(["add", "-f", "--", marker.file]))
            yield* Effect.promise(() => git(["add", "-f", "--", foreign]))
            const contaminated = yield* Effect.promise(() => git(["write-tree"]))
            yield* Effect.promise(() =>
              assert.rejects(Effect.runPromise(snapshot.restore(contaminated)), /protected runtime data/),
            )
            yield* Effect.promise(() =>
              assert.rejects(
                Effect.runPromise(snapshot.revert([{ hash: contaminated, files: markers.map((item) => item.file) }])),
                /protected runtime data/,
              ),
            )
            for (const marker of markers)
              assert.deepEqual(yield* Effect.promise(() => fs.readFile(marker.file)), marker.bytes)
            assert.equal(yield* Effect.promise(() => Bun.file(foreign).text()), "Reserved legacy metadata")
            const cleaned = yield* snapshot.track()
            assert.equal(
              cleaned,
              before,
              "Unchanged legacy coordination entries must be removed from the index: " +
                (yield* Effect.promise(() => git(["diff", "--name-only", before, cleaned!]))),
            )
            yield* Effect.promise(() => git(["add", "-f", "--", file]))
            const legacy = yield* Effect.promise(() => git(["write-tree"]))
            yield* Effect.promise(() => Bun.write(file, "Runtime current"))
            yield* Effect.promise(() =>
              assert.rejects(Effect.runPromise(snapshot.restore(legacy)), /protected runtime data/),
            )
            yield* Effect.promise(() =>
              assert.rejects(
                Effect.runPromise(snapshot.revert([{ hash: legacy, files: [file] }])),
                /protected runtime data/,
              ),
            )
            assert.equal(yield* Effect.promise(() => Bun.file(file).text()), "Runtime current")
            const after = yield* snapshot.track()
            assert.equal(after, before, "Runtime changes must not alter the workspace snapshot")
            assert.equal(yield* Effect.promise(() => Bun.file(sibling).text()), "Sibling user work")
            const repeated = yield* snapshot.track()
            assert.equal(repeated, after)
          }),
        ).pipe(Effect.provide(Snapshot.defaultLayer)),
      ),
  })
} finally {
  owner.release()
  await lease.release()
}
await disposeTestRuntime()
