import assert from "node:assert/strict"
import path from "node:path"
import { Effect } from "effect"
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
await disposeTestRuntime()
