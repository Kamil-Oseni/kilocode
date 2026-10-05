import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, realpath, rename, symlink } from "node:fs/promises"
import path from "node:path"
import { NativeProcess } from "../../../src/kilocode/process-host"

const root = process.env.RAYA_SOURCE_JOB_TEST_ROOT!
const mode = process.argv[2]
const helper = path.resolve("native/kilocode/bin/raya-process-host.exe")
const command = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(command).arrayBuffer()))
  .digest("hex")
const profile = path.join(root, "profile")
const control = path.join(root, "source")
const token = randomUUID()
await mkdir(profile)
const integer = (value: number) => {
  const data = Buffer.alloc(4)
  data.writeUInt32LE(value)
  return data
}
const text = (value: string) => Buffer.concat([integer(value.length), Buffer.from(value, "utf16le")])
const packet = (...values: (number | string)[]) =>
  Buffer.concat(values.map((value) => (typeof value === "number" ? integer(value) : text(value))))
const publish = async (file: string, value: Buffer) => {
  const temp = `${file}.tmp`
  await Bun.write(temp, value)
  await rename(temp, file)
}
const wait = async (file: string, timeout = 15000) => {
  const end = Date.now() + timeout
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= end) throw new Error(`Missing ${file}`)
    await Bun.sleep(10)
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
const rootfile = path.join(root, "root.ts")
const childfile = path.join(root, "child.ts")
await Bun.write(
  childfile,
  `import { open } from "node:fs/promises"
const root = process.env.RAYA_SOURCE_JOB_TEST_ROOT!
const file = await open(root + "/native.log", "a")
await Bun.write(root + "/child-entered", String(process.pid))
while (!(await Bun.file(root + "/child-release").exists())) await Bun.sleep(10)
try { await file.write("RAYA_SOURCE_CHILD_FINAL_MARKER\\n") } finally { await file.close() }
await Bun.write(root + "/child-closed", "closed")
`,
)
await Bun.write(
  rootfile,
  `import { spawn } from "node:child_process"
const root = process.env.RAYA_SOURCE_JOB_TEST_ROOT!
const child = spawn(process.execPath, [root + "/child.ts"], { detached: true, stdio: "ignore", env: process.env, windowsHide: true })
child.unref()
await Bun.write(root + "/root-entered", String(process.pid))
while (!(await Bun.file(root + "/root-release").exists())) await Bun.sleep(10)
`,
)
const launcher =
  mode === "controller"
    ? Bun.spawn(
        [
          process.execPath,
          "-e",
          'while (!(await Bun.file(process.env.RAYA_SOURCE_JOB_TEST_ROOT + "/controller-release").exists())) await Bun.sleep(10)',
        ],
        { windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env },
      )
    : undefined
const parent = await NativeProcess.inspect(launcher?.pid ?? process.pid)
assert.ok(typeof parent === "object" && parent !== null && "birth" in parent && typeof parent.birth === "string")
const frame = packet(1, 30000, command, digest, root, 1, rootfile, 1, 0, profile)
const host = Bun.spawn(
  [helper, "source-launch", String(launcher?.pid ?? globalThis.process.pid), parent.birth, control, token],
  {
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, RAYA_SOURCE_LAUNCH: frame.toString("base64") },
  },
)
const output = [new Response(host.stdout).text(), new Response(host.stderr).text()]
const owned: number[] = launcher ? [host.pid, launcher.pid] : [host.pid]
const state = { passed: false, forced: false }
const errors: unknown[] = []
const receipts: unknown[] = []
try {
  await wait(`${control}.source-launch`)
  const launch = await Bun.file(`${control}.source-launch`).json()
  assert.equal(launch.state, "suspended")
  assert.equal(launch.digest, digest)
  assert.equal(launch.token, token)
  assert.equal(await Bun.file(path.join(root, "root-entered")).exists(), false)
  owned.push(launch.pid)
  const request = (action: number) => packet(1, token, action, launch.pid, launch.birth)
  await publish(`${control}.source-go`, request(1))
  await wait(path.join(root, "root-entered"))
  await wait(path.join(root, "child-entered"))
  const pid = Number(await Bun.file(path.join(root, "child-entered")).text())
  owned.push(pid)
  if (launcher) {
    await Bun.write(path.join(root, "controller-release"), "release")
    assert.equal(await launcher.exited, 0)
    await Bun.sleep(150)
    assert.equal(alive(host.pid), true)
    assert.equal(alive(launch.pid), true)
    assert.equal(alive(pid), true)
  }
  if (mode === "wrongnonce") {
    await publish(`${control}.source-abort`, packet(1, randomUUID(), 3, launch.pid, launch.birth))
    await wait(`${control}.source-abort.refused`)
    await Bun.sleep(150)
    assert.equal(alive(launch.pid), true)
    assert.equal(alive(pid), true)
    assert.equal(await Bun.file(`${control}.source-retired`).exists(), false)
  }
  if (mode === "changedroot") {
    await rename(profile, `${profile}-original`)
    await mkdir(`${profile}-replacement`)
    await symlink(`${profile}-replacement`, profile, "junction")
  }
  if (mode.startsWith("broker")) {
    const directory = path.join(root, "broker")
    await mkdir(directory)
    const file = path.join(directory, "successor.ts")
    await Bun.write(
      file,
      `const root = process.env.RAYA_SOURCE_JOB_TEST_ROOT!
await Bun.write(root + "/broker-entered", String(process.pid))
while (!(await Bun.file(root + "/broker-release").exists())) await Bun.sleep(10)
`,
    )
    const env = {
      HOME: directory,
      USERPROFILE: directory,
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
      KILO_DB: path.join(directory, "private.db"),
      RAYA_DB: path.join(directory, "private.db"),
      RAYA_SOURCE_JOB_TEST_ROOT: root,
      PATH: globalThis.process.env.PATH!,
      SystemRoot: globalThis.process.env.SystemRoot!,
    }
    if (mode === "broker-env") env.XDG_STATE_HOME = profile
    if (mode === "broker-late") await publish(`${control}.source-capture`, request(2))
    await publish(
      `${control}.source-broker`,
      packet(
        1,
        token,
        randomUUID(),
        command,
        directory,
        1,
        file,
        Object.keys(env).length,
        ...Object.entries(env).flat(),
      ),
    )
    if (mode === "broker") {
      await wait(`${control}.source-broker-launched`)
      const broker = await Bun.file(`${control}.source-broker-launched`).json()
      assert.equal(broker.outsideJob, true)
      await wait(path.join(root, "broker-entered"))
      assert.equal(Number(await Bun.file(path.join(root, "broker-entered")).text()), broker.pid)
      owned.push(broker.pid)
      receipts.push(broker)
    } else {
      await wait(`${control}.source-broker.refused`)
      assert.equal(await Bun.file(`${control}.source-broker-launched`).exists(), false)
      assert.equal(await Bun.file(path.join(root, "broker-entered")).exists(), false)
      assert.equal(alive(launch.pid), true)
      assert.equal(alive(pid), true)
    }
  }
  if (mode !== "handoff" && mode !== "broker-late") await publish(`${control}.source-capture`, request(2))
  await Bun.write(path.join(root, "root-release"), "release")
  const end = Date.now() + 10000
  while (alive(launch.pid) && Date.now() < end) await Bun.sleep(10)
  assert.equal(alive(launch.pid), false)
  await Bun.sleep(150)
  assert.equal(alive(pid), true)
  assert.equal(alive(host.pid), true)
  assert.equal(await Bun.file(`${control}.source-retired`).exists(), false)
  if (mode === "forced") {
    await publish(`${control}.source-abort`, request(3))
  } else await Bun.write(path.join(root, "child-release"), "release")
  const code = await host.exited
  const uncertain = ["wrongnonce", "changedroot", "broker-env", "broker-late"].includes(mode)
  assert.equal(code, mode === "forced" || uncertain ? 1 : 0)
  const receipt = await Bun.file(`${control}.source-retired`).json()
  assert.equal(receipt.empty, true)
  assert.equal(receipt.rootExit, 0)
  assert.equal(receipt.forced, mode === "forced")
  assert.equal(receipt.success, mode !== "forced" && !uncertain)
  assert.equal(receipt.uncertain, uncertain || mode === "forced")
  assert.equal(receipt.capture, mode !== "handoff")
  assert.equal(receipt.members.length, 2)
  assert.equal(receipt.completeProfileCoverage, false)
  assert.equal(receipt.portableCaptureAuthorized, false)
  if (mode !== "forced")
    assert.equal(await Bun.file(path.join(root, "native.log")).text(), "RAYA_SOURCE_CHILD_FINAL_MARKER\n")
  if (mode === "broker")
    assert.equal(alive(owned[owned.length - 1]), true, "Outside-job successor must survive source job zero")
  receipts.push(receipt)
  state.passed = true
} catch (err) {
  errors.push(err)
} finally {
  await Promise.all(
    ["root-release", "child-release", "broker-release", "controller-release"].map((name) =>
      Bun.write(path.join(root, name), "release"),
    ),
  )
  const end = Date.now() + 15000
  while (owned.some(alive) && Date.now() < end) await Bun.sleep(20)
  if (owned.some(alive)) errors.push(new Error("Owned native processes remain live after fixture release"))
  if (host.exitCode === null) {
    state.forced = true
    host.kill("SIGKILL")
    await host.exited
  }
  const [stdout, stderr] = await Promise.all(output)
  await Bun.write(path.join(root, "stdout.log"), stdout)
  await Bun.write(path.join(root, "stderr.log"), stderr)
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({
      ...state,
      passed: state.passed && !errors.length,
      mode,
      receipts,
      errors: errors.map(String),
      processes: owned.map((pid) => ({ pid, absent: !alive(pid) })),
      portableCaptureAuthorized: false,
    }),
  )
}
if (errors.length) throw new AggregateError(errors, `Native source fixture failed; retained ${root}`)
