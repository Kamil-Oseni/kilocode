import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect, terminate, NativeProcess } from "../../../src/kilocode/process-host"

const helper = await NativeProcess.source()
const root = await mkdtemp(path.join(os.tmpdir(), "raya-offline-native-"))
const source = path.join(root, "source")
const control = path.join(root, "control")
await Promise.all([mkdir(source), mkdir(control)])
await mkdir(path.join(source, "nested"))
const bytes = Buffer.from([0, 255, 19, 0, 128, 42])
await writeFile(path.join(source, "nested", "binary.bin"), bytes)
const original = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-Command", `(Get-Acl -LiteralPath '${source.replaceAll("'", "''")}').Sddl`],
  {
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    },
  },
)
if (original.status !== 0)
  throw new Error(
    `Independent initial source DACL read failed: ${original.status}/${original.error}/${original.stderr}`,
  )
const owner = (await inspect(process.pid, helper)) as { birth: string }
const executable = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex")
const generation = randomUUID()
function frame(...values: (number | string)[]) {
  const body = Buffer.concat(
    values.map((value) => {
      const size = Buffer.alloc(4)
      if (typeof value === "number") {
        size.writeUInt32LE(value)
        return size
      }
      size.writeUInt32LE(value.length)
      return Buffer.concat([size, Buffer.from(value, "utf16le")])
    }),
  )
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length)
  return Buffer.concat([size, body])
}
const child = spawn(helper, ["profile-offline"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
const lines: unknown[] = []
const errors: Buffer[] = []
let buffered = ""
let resolve: (value: Record<string, unknown>) => void
let reject: (err: unknown) => void
const ready = new Promise<Record<string, unknown>>((yes, no) => {
  resolve = yes
  reject = no
})
child.stdout.on("data", (value) => {
  buffered += value.toString()
  while (buffered.includes("\n")) {
    const end = buffered.indexOf("\n")
    const row = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    lines.push(row)
    if (row.state === "held") resolve(row)
  }
})
child.stderr.on("data", (value) => errors.push(value))
const exited = new Promise<number | null>((yes, no) => {
  child.once("error", no)
  child.once("exit", (code) => {
    reject(new Error(`Guardian ended ${code}: ${Buffer.concat(errors)}`))
    yes(code)
  })
})
void ready.catch(() => undefined)
child.stdin.write(
  frame(1, 0, process.pid, owner.birth, executable, digest, control, generation, 30000, 128, 1024 * 1024, 1, 0, source),
)
const receipt = await ready
const pin = receipt.guardian as { pid: number; birth: string }
const staged = path.join(control, "image", "0", "nested", "binary.bin")
if (!(await readFile(staged)).equals(bytes)) throw new Error("Raw binary stage mismatch")
if (process.argv.includes("--parent-death")) {
  const destination = process.argv.at(-1)
  if (!destination || destination === "--parent-death") throw new Error("Parent-death control missing")
  const guardian = (await inspect(pin.pid, helper)) as { birth: string }
  if (guardian.birth !== pin.birth) throw new Error("Independent guardian birth differs")
  await writeFile(
    destination,
    JSON.stringify({
      root,
      source,
      control,
      helper,
      helperDigest: createHash("sha256")
        .update(await readFile(helper))
        .digest("hex"),
      sourcePID: process.pid,
      sourceBirth: owner.birth,
      relayPID: child.pid,
      guardianPID: pin.pid,
      guardianBirth: guardian.birth,
      original: original.stdout.trim(),
    }),
  )
  const deadline = Date.now() + 15000
  while (!existsSync(destination + ".permit")) {
    if (Date.now() >= deadline) throw new Error("Parent-death driver never held guardian")
    await Bun.sleep(20)
  }
  process.exit(0)
}
if (process.argv.includes("--crash")) {
  await terminate(pin.pid, pin.birth)
  const forced = await exited
  const recovery = spawn(process.execPath, [path.join(import.meta.dir, "source-offline-recover.ts"), control, helper], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output: Buffer[] = []
  const diagnostic: Buffer[] = []
  recovery.stdout.on("data", (value) => output.push(value))
  recovery.stderr.on("data", (value) => diagnostic.push(value))
  const code = await new Promise<number | null>((yes, no) => {
    recovery.once("error", no)
    recovery.once("close", yes)
  })
  if (code !== 0) throw new Error(`Fresh recovery refused: ${Buffer.concat(diagnostic)}`)
  await writeFile(path.join(source, "after-recovery.txt"), "recovered")
  if (!(await readFile(path.join(source, "nested", "binary.bin"))).equals(bytes))
    throw new Error("Original changed during crash recovery")
  console.log(
    JSON.stringify(
      {
        root,
        source,
        control,
        relayPID: child.pid,
        guardianPID: pin.pid,
        guardianBirth: pin.birth,
        forced,
        recoveryPID: recovery.pid,
        recoveryCode: code,
        receipt: JSON.parse(Buffer.concat(output).toString()),
        restoredWritable: true,
        binaryUnchanged: true,
        captureSuccessful: false,
        portableCaptureAuthorized: false,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}
const writer = spawn(
  process.execPath,
  [
    "-e",
    `const {writeFileSync}=require('node:fs'); const paths=JSON.parse(process.argv[1]); console.log(JSON.stringify(paths.map(p=>{try{writeFileSync(p,'wrong');return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'||e.code==='EBUSY'}})))`,
    JSON.stringify([
      path.join(source, "new.txt"),
      path.join(source, "nested", "new.txt"),
      path.join(source, "nested", "binary.bin"),
    ]),
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
)
const chunks: Buffer[] = []
writer.stdout.on("data", (value) => chunks.push(value))
const foreign = await new Promise<number | null>((yes, no) => {
  writer.once("error", no)
  writer.once("exit", yes)
})
const denied = JSON.parse(Buffer.concat(chunks).toString())
child.stdin.write(frame(1, generation))
const code = await exited
if (foreign !== 0 || denied.length !== 3 || denied.some((value: unknown) => value !== true))
  throw new Error("Raw foreign writer was not refused")
if (code !== 0) throw new Error(`Guardian rollback failed: ${JSON.stringify(lines)}`)
await writeFile(path.join(source, "after.txt"), "restored")
if (!(await readFile(path.join(source, "nested", "binary.bin"))).equals(bytes)) throw new Error("Original changed")
console.log(
  JSON.stringify(
    {
      root,
      source,
      control,
      pid: child.pid,
      foreignPID: writer.pid,
      code,
      foreign,
      denied,
      binaryUnchanged: true,
      receipt,
      retired: lines.at(-1),
      portableCaptureAuthorized: false,
    },
    null,
    2,
  ),
)
