import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { inspect } from "../../../src/kilocode/process-host"

const [root, helper, layout] = process.argv.slice(2)
if (!root || !helper) throw new Error("Negative crash fixture arguments missing")
const home = path.join(root, "home")
const control =
  layout === "normal"
    ? path.join(home, "AppData", "Local", "Raya", "offline-recovery", "capture")
    : path.join(root, "control")
await mkdir(home)
await mkdir(control, { recursive: true })
const bytes = Buffer.from("SYNTHETIC_EXCLUDED_SIBLING_" + randomUUID())
await writeFile(path.join(home, "unrelated.bin"), bytes)
const acl = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-Command", `(Get-Acl -LiteralPath '${home.replaceAll("'", "''")}').Sddl`],
  { windowsHide: true, encoding: "utf8" },
)
if (acl.status !== 0) throw new Error("Negative initial ACL observation failed")
const digest = createHash("sha256")
  .update(await readFile(helper))
  .digest("hex")
const source = z
  .object({ birth: z.string() })
  .passthrough()
  .parse(await inspect(process.pid, helper))
const executable = await realpath(process.execPath)
const hash = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex")
const generation = randomUUID()
function frame(...values: (number | string)[]) {
  const chunks = values.map((value) => {
    const prefix = Buffer.alloc(4)
    if (typeof value === "number") {
      prefix.writeUInt32LE(value)
      return prefix
    }
    prefix.writeUInt32LE(value.length)
    return Buffer.concat([prefix, Buffer.from(value, "utf16le")])
  })
  const body = Buffer.concat(chunks)
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  return Buffer.concat([prefix, body])
}
const child = spawn(helper, ["profile-offline"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
const ready = Promise.withResolvers<unknown>()
const ended = Promise.withResolvers<number | null>()
let buffered = ""
child.stdout.on("data", (data: Buffer) => {
  buffered += data.toString()
  while (buffered.includes("\n")) {
    const end = buffered.indexOf("\n")
    const row: unknown = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    ready.resolve(row)
  }
})
child.stderr.on("data", (data: Buffer) => process.stderr.write(data))
child.once("error", (err) => {
  ready.reject(err)
  ended.reject(err)
})
child.once("exit", (code) => {
  ready.reject(new Error("Negative guardian ended before ready"))
  ended.resolve(code)
})
const first = path.join(home, ".kilocode")
const config = path.join(home, ".config")
const second = path.join(config, "kilo")
child.stdin.write(
  frame(
    2,
    0,
    process.pid,
    source.birth,
    executable,
    hash,
    control,
    generation,
    30000,
    128,
    1048576,
    2,
    2,
    home,
    1,
    first,
    2,
    home,
    2,
    second,
    config,
  ),
)
const held = z
  .object({
    version: z.literal(2),
    state: z.literal("held"),
    files: z.array(z.unknown()).length(0),
    roots: z.array(z.object({ kind: z.literal("negative"), staged: z.string() }).passthrough()).length(2),
    guardian: z.object({ pid: z.number(), birth: z.string() }).passthrough(),
  })
  .passthrough()
  .parse(await ready.promise)
for (const root of held.roots)
  if ((await readdir(root.staged)).length) throw new Error("Negative stage captured siblings")
await writeFile(
  path.join(root, "ready.json"),
  JSON.stringify({
    sourcePID: process.pid,
    sourceBirth: source.birth,
    relayPID: child.pid,
    guardianPID: held.guardian.pid,
    guardianBirth: held.guardian.birth,
    helper,
    helperDigest: digest,
    home,
    control,
    first,
    second,
    config,
    siblingDigest: createHash("sha256").update(bytes).digest("hex"),
    originalAcl: acl.stdout.trim(),
    emptyStages: true,
    zeroCapturedFiles: true,
  }),
)
const deadline = Date.now() + 25000
while (!existsSync(path.join(root, "permit"))) {
  if (Date.now() > deadline) throw new Error("Negative crash driver did not release fixture")
  await Bun.sleep(20)
}
const code = await ended.promise
await writeFile(path.join(root, "relay-result.json"), JSON.stringify({ code }))
if (code !== 77) throw new Error("Controlled guardian fault status differs")
