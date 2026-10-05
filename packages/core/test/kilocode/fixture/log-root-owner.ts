import assert from "node:assert/strict"
import path from "node:path"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "../../../src/global"
import { Log } from "../../../src/util/log"
import { ownedFileLogger, drainFileLoggers } from "../../../src/kilocode/file-logger"
import { ProfileRoots } from "../../../src/kilocode/profile-roots"

const dir = process.argv[2]
const mode = process.argv[3]
const marker = process.argv[4]
if (!dir || !marker) throw new Error("Missing isolated file-owner fixture input")
Global.Path.log = dir
const baseline = ProfileRoots.snapshot()
const added = () =>
  ProfileRoots.snapshot().filter(
    (root) => !baseline.some((prior) => prior.kind === root.kind && prior.path === root.path),
  )
if (mode === "refused") {
  await assert.rejects(Log.init({ print: false, dev: true }), /maintenance excludes/)
  await assert.rejects(Log.drain(), /Legacy logger retirement failed/)
  assert.deepEqual(ProfileRoots.snapshot(), baseline)
  console.log(JSON.stringify({ passed: true, mode, roots: [] }))
} else if (mode === "unused") {
  await drainFileLoggers()
  await Log.drain()
  assert.deepEqual(ProfileRoots.snapshot(), baseline)
  assert.equal(await Bun.file(path.join(dir, "dev.log")).exists(), false)
  console.log(JSON.stringify({ passed: true, mode, roots: [] }))
} else {
  const runtime =
    mode === "effect"
      ? ManagedRuntime.make(
          Logger.layer([
            ownedFileLogger(
              Logger.make((opts) => String(opts.message)),
              path.join(dir, "actual.log"),
            ),
          ]).pipe(Layer.provide(NodeFileSystem.layer)),
        )
      : undefined
  if (runtime) await runtime.runPromise(Effect.logInfo(marker))
  else {
    await Log.init({ print: false, dev: true })
    Log.Default.info(marker)
  }
  const roots = added()
  assert.equal(roots.length, 1)
  const file = runtime ? path.join(roots[0].path, "actual.log") : Log.file()
  const stop = performance.now() + 5_000
  while (!(await Bun.file(file).exists()) || !(await Bun.file(file).text()).includes(marker)) {
    if (performance.now() > stop) throw new Error("Native logger publication deadline")
    await Bun.sleep(10)
  }
  console.log(JSON.stringify({ ready: true, mode, roots, file }))
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).includes("close")) break
  }
  if (runtime) {
    await drainFileLoggers()
    await runtime.dispose()
  } else await Log.drain()
  assert.ok((await Bun.file(file).text()).includes(marker))
  assert.deepEqual(added(), roots)
  console.log(JSON.stringify({ passed: true, mode, roots, file, marker, portable: false }))
}
