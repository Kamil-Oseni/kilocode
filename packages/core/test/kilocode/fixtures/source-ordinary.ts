import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, symlink } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import z from "zod"
import { launch } from "../../../src/kilocode/source-launch"
import { observe } from "../../../src/kilocode/source-observer"
import { NativeProcess } from "../../../src/kilocode/process-host"

const root = process.env.RAYA_SOURCE_ORDINARY_ROOT!
const mode = process.argv[2]
const helper = path.resolve("native/kilocode/bin/raya-process-host.exe")
const hash = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
const profile = path.join(root, "profile")
await mkdir(profile)
const script = path.join(root, "source.ts")
await Bun.write(
  script,
  `const root = process.env.RAYA_SOURCE_ORDINARY_ROOT!
const mode = process.argv[2]
const children: number[] = []
if (mode === "ordinary" || mode === "legacy") {
  for (let batch = 0; batch < 8; batch++) {
    const jobs = Array.from({length: 32}, () => Bun.spawn([process.env.ComSpec ?? "C:/Windows/System32/cmd.exe", "/d", "/c", "exit", "0"], {stdin:"ignore",stdout:"ignore",stderr:"ignore",windowsHide:true}))
    children.push(...jobs.map(child => child.pid))
    await Promise.all(jobs.map(child => child.exited))
  }
}
await Bun.write(root + "/entered.json", JSON.stringify({pid:process.pid,children}))
while (!(await Bun.file(root + "/release").exists())) await Bun.sleep(10)
if (mode === "failure") process.exitCode = 1
`,
)
const app = await launch({
  executable: process.execPath,
  digest: await hash(process.execPath),
  helper: { executable: helper, digest: await hash(helper) },
  cwd: root,
  args: [script, mode],
  env: Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
  ),
  roots: [{ kind: "json", path: profile }],
  ...(mode === "legacy" ? {} : { policy: { version: 1 as const, directories: [root], files: [] } }),
})
async function collect(stream: Readable | null) {
  assert(stream)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    assert(Buffer.isBuffer(chunk))
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}
const output = [collect(app.child.stdout), collect(app.child.stderr)]
const watchers = [
  observe({ pid: app.ticket.header.pid, birth: app.ticket.header.birth, executable: process.execPath, timeout: 60000 }),
  observe({ pid: app.ticket.header.helper, birth: app.ticket.header.helperBirth, executable: helper, timeout: 60000 }),
]
const errors: string[] = []
const state: {
  passed: boolean
  family?: unknown
  strict?: unknown
  exits?: unknown
  absence: { pid: number; birth: string; absent: boolean }[]
} = { passed: false, absence: [] }
const wait = async (file: string) => {
  const deadline = Date.now() + 35000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > deadline) throw new Error(`Missing private fixture ${file}`)
    await Bun.sleep(10)
  }
}
try {
  await Promise.all(watchers.map((value) => value.ready))
  await app.start()
  await wait(path.join(root, "entered.json"))
  if (mode === "rejected") {
    const data = Buffer.concat([
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([36, 0, 0, 0]),
      Buffer.from(randomUUID(), "utf16le"),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from([app.ticket.header.pid & 255, (app.ticket.header.pid >> 8) & 255, 0, 0]),
      Buffer.from([app.ticket.header.birth.length, 0, 0, 0]),
      Buffer.from(app.ticket.header.birth, "utf16le"),
    ])
    await Bun.write(app.ticket.control + ".source-abort", data)
    await wait(app.ticket.control + ".source-abort.refused")
  }
  if (mode === "changed") {
    await rename(profile, profile + "-original")
    await mkdir(profile + "-replacement")
    await symlink(profile + "-replacement", profile, "junction")
  }
  if (mode === "forced") await app.abort()
  else await Bun.write(path.join(root, "release"), "release")
  const exits = await Promise.all([app.sourceExit, app.exit, ...watchers.map((value) => value.done)])
  state.exits = exits
  const family = await Bun.file(app.ticket.control + ".source-family-retired").json()
  const strict = await Bun.file(app.ticket.control + ".source-retired").json()
  state.family = family
  state.strict = strict
  assert.equal(family.capture, false)
  assert.equal(family.familyZeroObserved, true)
  assert.equal(family.completeProfileCoverage, false)
  assert.equal(family.portableCaptureAuthorized, false)
  if (mode === "ordinary" || mode === "legacy") {
    assert.ok(
      family.totalProcesses > family.members.length,
      "Real short-lived burst must miss at least one individual native handle",
    )
    assert.equal(family.memberObservationsComplete, false)
    assert.equal(strict.uncertain, true)
    assert.equal(strict.success, false)
  }
  assert.equal(exits[1].code, mode === "ordinary" ? 0 : 1)
  assert.equal(exits[3], mode === "ordinary" ? 0 : 1)
  assert.equal(exits[2], mode === "failure" || mode === "forced" ? 1 : 0)
  assert.equal(family.success, mode === "ordinary")
  if (mode === "ordinary")
    await assert.rejects(app.retired(), "Ordinary physical closure must not become authenticated capture authority")
  for (const value of [
    { pid: app.ticket.header.pid, birth: app.ticket.header.birth },
    { pid: app.ticket.header.helper, birth: app.ticket.header.helperBirth },
  ]) {
    const actual = z
      .object({ status: z.string(), birth: z.string().nullable() })
      .parse(await NativeProcess.inspect(value.pid, helper))
    const absent = actual.status === "gone" || actual.birth !== value.birth
    state.absence.push({ ...value, absent })
    assert.equal(absent, true)
  }
  state.passed = true
} catch (err) {
  errors.push(String(err))
} finally {
  await Bun.write(path.join(root, "release"), "release")
  if (app.child.exitCode === null) await app.abort().catch((err) => errors.push(String(err)))
  await Promise.all(watchers.map((value) => value.close()))
  const [stdout, stderr] = await Promise.all(output)
  await Bun.write(path.join(root, "stdout.log"), stdout)
  await Bun.write(path.join(root, "stderr.log"), stderr)
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({ ...state, mode, errors, portableCaptureAuthorized: false }, null, 2),
  )
}
if (errors.length) throw new Error(`Retained ${root}: ${errors.join("; ")}`)
