import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { children, configure, changed } from "./source-launch-admission-adapter"

const root = process.env.RAYA_SOURCE_ADMISSION_TEST_ROOT!
const mode = process.argv[2]
assert.ok(mode === "malformed" || mode === "identity" || mode === "ended")
const profile = path.join(root, "profile")
await mkdir(profile)
const command = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(await readFile(command))
  .digest("hex")
const body = path.join(root, "body.ts")
await writeFile(body, `await Bun.write(${JSON.stringify(path.join(root, "started"))}, "unexpected Go")`)

const source = path.resolve("src/kilocode/source-launch.ts")
const adapter = fileURLToPath(new URL("./source-launch-admission-adapter.ts", import.meta.url))
configure(mode)
Bun.plugin({
  name: "retain-real-source-admission",
  setup(build) {
    build.onLoad({ filter: /[\\/]source-launch\.ts$/ }, async (args) => {
      assert.equal(path.resolve(args.path), source)
      const bytes = await readFile(source, "utf8")
      const imports = ['import { spawn } from "node:child_process"', 'import { read } from "./source-readiness"']
      for (const value of imports) assert.equal(bytes.split(value).length, 2)
      return {
        contents: bytes
          .replace(imports[0], `import { spawn } from ${JSON.stringify(adapter)}`)
          .replace(imports[1], `import { read } from ${JSON.stringify(adapter)}`),
        loader: "ts",
      }
    })
  },
})
const { launch, LaunchFailure } = await import("../../../src/kilocode/source-launch")
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value
}
const outcome = await launch({
  executable: command,
  digest,
  cwd: root,
  args: [body],
  env,
  roots: [{ kind: "json", path: profile }],
  timeout: 1000,
}).then(
  () => ({ accepted: true as const }),
  (error: unknown) => ({ accepted: false as const, error }),
)
assert.equal(children.length, 1)
const held = children[0]
// Always join the actual original before the expected red assertion; no Go, abort or kill.
const [exit] = await Promise.all([held.exit, held.close, ...held.streams])
assert.equal(changed(), true)
assert.equal(exit.signal, null)
assert.notEqual(exit.code, 0)
assert.equal(await Bun.file(path.join(root, "started")).exists(), false)
assert.equal(outcome.accepted, false)
if (outcome.accepted) throw new Error("Pre-Go fault unexpectedly admitted")
const primary = outcome.error instanceof AggregateError ? outcome.error.cause : outcome.error
if (mode !== "identity") assert.ok(primary instanceof SyntaxError)
if (mode === "identity") {
  assert.ok(primary instanceof Error)
  assert.ok(primary.message.startsWith("Source suspended identity differs; retained at "))
}
await writeFile(
  path.join(root, "original-joined.json"),
  JSON.stringify({
    pid: held.child.pid,
    exit,
    mode,
    injectionVerified: true,
    targetNeverStarted: true,
    originalExitJoined: true,
    originalCloseJoined: true,
    originalStreamsJoined: true,
    ordinaryRetirement: false,
    primary: mode !== "identity" ? "malformed-header" : "suspended-identity-mismatch",
  }),
  { flag: "wx" },
)
assert.ok(outcome.error instanceof AggregateError)
assert.ok(outcome.error instanceof LaunchFailure)
assert.deepEqual(Object.keys(outcome.error).sort(), ["cleanup", "name"])
assert.ok(outcome.error.cause instanceof Error)
assert.ok(outcome.error.errors.length >= 2, "Primary and native nonzero cleanup remain distinct")
assert.ok("cleanup" in outcome.error)
assert.deepEqual(outcome.error.cleanup, {
  exit,
  originalExitJoined: true,
  originalCloseJoined: true,
  originalStreamsJoined: true,
  ordinaryRetirement: false,
  portableCaptureAuthorized: false,
  forced: "unknown",
})
await writeFile(path.join(root, "passed.json"), JSON.stringify({ passed: true, mode }), { flag: "wx" })
