import assert from "node:assert/strict"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { BackgroundProcess } from "../../../src/kilocode/background-process"
import { SessionID } from "../../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Filesystem } from "../../../src/util/filesystem"
import { KiloShutdown } from "../../../src/kilocode/cli/shutdown"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { drainFileLoggers } from "@opencode-ai/core/kilocode/file-logger"
import * as Log from "@opencode-ai/core/util/log"
import { provideTestInstance, disposeTestRuntime } from "../../fixture/fixture"

const root = process.env.RAYA_BACKGROUND_TEST_ROOT!
const mode = process.argv[2]
const directory = path.join(root, "workspace")
await mkdir(directory, { recursive: true })
const wait = async (file: string, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`Missing native evidence ${file}`)
    await Bun.sleep(20)
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const owned: number[] = []
const state = { passed: false, forced: false }
const evidence: unknown[] = []
const errors: unknown[] = []
const release = path.join(root, "release")
try {
  await provideTestInstance({
    directory,
    fn: async () => {
      const script = path.join(root, "native-child.ts")
      await Bun.write(
        script,
        `import { open } from "node:fs/promises"
const root = process.env.RAYA_BACKGROUND_TEST_ROOT!
const file = await open(root + "/native.log", "a")
await Bun.write(root + "/command-pid", String(process.pid))
console.log("RAYA_BACKGROUND_READY")
while (${mode === "timeout" ? "true" : "!(await Bun.file(process.env.RAYA_BACKGROUND_CAPTURE_REQUEST!).exists())"} && !(await Bun.file(root + "/release").exists())) await Bun.sleep(10)
await Bun.write(root + "/entered", "entered")
while (!(await Bun.file(root + "/release").exists())) await Bun.sleep(10)
${mode === "failed" ? "await file.close()" : ""}
try { await file.write("RAYA_BACKGROUND_FINAL_MARKER\\n") } finally { await file.close() }
await Bun.write(root + "/closed", "closed")
`,
      )
      const quote = (value: string) => `"${value.replaceAll("\\", "/").replaceAll('"', '""')}"`
      const info = await BackgroundProcess.start({
        sessionID: SessionID.descending(),
        lifetime: "persistent",
        command: `& ${quote(process.execPath)} ${quote(script)}`,
        cwd: directory,
        ready: { pattern: "RAYA_BACKGROUND_READY", timeout: 10000 },
      })
      assert.ok(info.pid)
      owned.push(info.pid)
      await wait(path.join(root, "command-pid"))
      owned.push(Number(await Bun.file(path.join(root, "command-pid")).text()))
      const scope = `scope-${Hash.fast(`global\0${Filesystem.resolve(directory)}`)}`
      const manifest = path.join(Global.Path.state, "background-process", scope, `${info.id}.json`)
      const control = path.join(Global.Path.state, "background-process", scope, `${info.id}.stop`)
      const original = await Bun.file(manifest).text()
      const altered =
        mode === "foreign"
          ? (() => {
              const record = JSON.parse(original)
              record.witness.birth = (BigInt(record.witness.birth) + 1n).toString()
              return JSON.stringify(record)
            })()
          : undefined
      if (altered) await Bun.write(manifest, altered)
      const closed = BackgroundProcess.closeForCapture()
      assert.equal(closed, BackgroundProcess.closeForCapture())
      const outcome = closed.then(
        (value) => ({ value }),
        (err: unknown) => ({ err }),
      )
      await assert.rejects(
        BackgroundProcess.start({ sessionID: SessionID.descending(), command: "late" }),
        /admission is closed/,
      )
      if (mode === "foreign") {
        const result = await outcome
        assert.ok("err" in result)
        assert.match(String(result.err), /identity changed/)
        assert.equal(await Bun.file(`${control}.capture`).exists(), false)
        assert.equal(alive(info.pid), true)
        assert.equal(await Bun.file(manifest).text(), altered)
      } else if (mode === "timeout") {
        const result = await outcome
        assert.ok("err" in result)
        assert.equal(await Bun.file(`${control}.capture-uncertain`).exists(), true)
        assert.equal(await Bun.file(`${control}.capture-closed`).exists(), false)
        assert.equal(await Bun.file(control).exists(), false)
        assert.equal(alive(info.pid), true)
      } else {
        await wait(path.join(root, "entered"))
        let settled = false
        void outcome.then(() => {
          settled = true
        })
        try {
          await Bun.sleep(150)
          assert.equal(settled, false)
          assert.equal(await Bun.file(`${control}.capture-closed`).exists(), false)
          assert.equal(alive(info.pid), true)
          assert.equal(await Bun.file(path.join(root, "closed")).exists(), false)
        } finally {
          await Bun.write(release, "release")
        }
        const result = await outcome
        if (mode === "failed") {
          assert.ok("err" in result)
          assert.equal(await Bun.file(`${control}.capture-uncertain`).exists(), true)
          assert.equal(await Bun.file(`${control}.capture-closed`).exists(), false)
        } else {
          assert.ok("value" in result)
          assert.equal(result.value.length, 1)
          assert.equal(result.value[0]?.native.forced, false)
          assert.equal(result.value[0]?.native.code, 0)
          assert.equal(result.value[0]?.supervisor.exit, 0)
          assert.equal(await Bun.file(path.join(root, "native.log")).text(), "RAYA_BACKGROUND_FINAL_MARKER\n")
          assert.equal((await Bun.file(manifest).json()).info.status, "stopped")
          evidence.push(...result.value)
        }
      }
    },
  })
  state.passed = true
} catch (err) {
  errors.push(err)
  throw err
} finally {
  await Bun.write(release, "release")
  const deadline = Date.now() + 20000
  while (owned.some(alive) && Date.now() < deadline) await Bun.sleep(50)
  if (owned.some(alive)) errors.push(new Error("Owned background processes must exit naturally"))
  for (const cleanup of [
    () => KiloShutdown.run(),
    disposeTestRuntime,
    () => RuntimeRegistry.drain(),
    drainFileLoggers,
    () => Log.drain(),
    closeProcessProfile,
  ]) {
    await cleanup().catch((err: unknown) => {
      errors.push(err)
    })
  }
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({
      ...state,
      passed: state.passed && errors.length === 0,
      mode,
      evidence,
      errors: errors.map((err) => (err instanceof Error ? { name: err.name, message: err.message } : String(err))),
      processes: owned.map((pid) => ({ pid, absent: !alive(pid) })),
      portableCaptureAuthorized: false,
    }),
  )
  if (errors.length) throw new AggregateError(errors, "Background fixture failed; retained profile and receipt")
}
