import assert from "node:assert/strict"
import path from "node:path"
import { copyFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { start, Sources } from "../../src/services/cli-backend/managed-source"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"

const executable = path.join(process.env.KILO_TEST_HOME!, "bun.exe")
await copyFile(process.execPath, executable)
const helper = path.join(process.env.KILO_TEST_HOME!, "raya-process-host.exe")
await copyFile(path.resolve("../core/native/kilocode/bin/raya-process-host.exe"), helper)
await Bun.write(
  path.join(process.env.KILO_TEST_HOME!, "raya-process-host.json"),
  JSON.stringify({
    version: 1,
    exe: createHash("sha256")
      .update(Buffer.from(await Bun.file(helper).arrayBuffer()))
      .digest("hex"),
  }),
)
const mode = process.argv[2] ?? "natural"
const input = {
  executable,
  cwd: process.env.KILO_TEST_HOME!,
  args: ["-e", "console.log('RAYA_MANAGED_NATIVE_SOURCE'); process.exit(0)"],
  env: process.env,
  helper,
}
if (mode !== "natural") {
  const owner = new Sources()
  const marker = path.join(process.env.KILO_TEST_HOME!, "must-not-run")
  const selected = { ...input, args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'unexpected')`] }
  if (mode === "capture" || mode === "late-capture") {
    const live = {
      ...input,
      args: ["-e", `await Bun.sleep(1200); await Bun.write(${JSON.stringify(marker)}, 'natural'); process.exit(0)`],
    }
    const pending = owner.create(live)
    if (mode === "capture") await pending
    const capture = owner.captureSource()
    assert.equal(owner.captureSource(), capture)
    await assert.rejects(owner.create(live), /producer is retired/)
    const source = await pending
    assert.equal(await capture, source)
    const close = owner.close()
    assert.equal(owner.close(), close)
    await close
    assert.equal(await Bun.file(marker).text(), "natural")
    assert.equal((await source.session.sourceExit).code, 0)
    const retired = await Bun.file(`${source.session.ticket.control}.source-family-retired`).json()
    assert.equal(retired.forced, false)
    assert.equal(retired.rootExit, 0)
    assert.equal(retired.familyZeroObserved, true)
    assert.equal(retired.capture, false)
    console.log(
      JSON.stringify({
        passed: true,
        mode,
        sourceExit: 0,
        forced: false,
        portable: false,
        scope: "Natural owner handoff only; no archive or complete authority",
      }),
    )
    process.exit(0)
  }
  if (mode === "pending") {
    const pending = owner.create(selected)
    const close = owner.close()
    assert.equal(owner.close(), close)
    await assert.rejects(pending, /producer is retired/)
    await close
    await assert.rejects(owner.create(selected), /producer is retired/)
  }
  if (mode === "suspended") {
    const source = await owner.create(selected)
    await owner.close()
    assert.equal(source.session.child.exitCode, 1)
    assert.equal((await NativeProcess.inspect(source.session.ticket.header.pid, helper)).status, "gone")
    assert.equal((await NativeProcess.inspect(source.session.ticket.header.helper, helper)).status, "gone")
  }
  if (mode === "failure") {
    await assert.rejects(
      owner.create({ ...selected, executable: path.join(process.env.KILO_TEST_HOME!, "missing.exe") }),
    )
    const close = owner.close()
    await assert.rejects(close, /cleanup failed/)
    assert.equal(owner.close(), close)
  }
  assert.equal(await Bun.file(marker).exists(), false)
  console.log(
    JSON.stringify({
      passed: true,
      mode,
      portable: false,
      scope: "Joined forced disposal only, not natural capture authority",
    }),
  )
  process.exit(0)
}
const source = await start(input)
assert.notEqual(source.session.child.pid, source.session.ticket.header.pid)
assert.equal(source.session.ticket.header.version, 2)
assert.equal(source.exited, false)
let output = ""
source.session.child.stdout!.on("data", (chunk: Buffer) => {
  output += chunk.toString()
})
await source.session.start()
const exit = await source.session.sourceExit
const family = await source.session.exit
assert.equal(exit.pid, source.session.ticket.header.pid)
assert.equal(exit.code, 0)
assert.equal(family.code, 0)
assert.equal(source.exited, true)
assert.ok(output.includes("RAYA_MANAGED_NATIVE_SOURCE"))
console.log(JSON.stringify({ passed: true, sourceExit: exit.code, familyExit: family.code, portable: false }))
