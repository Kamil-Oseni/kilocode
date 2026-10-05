import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { launch } from "../../../src/kilocode/source-launch"
import { serve } from "../../../src/kilocode/source-pipe"
import { NativeProcess } from "../../../src/kilocode/process-host"

const root = process.env.RAYA_CORE_HANDOFF_TEST_ROOT!
const profile = path.join(root, "profile")
const directory = path.join(root, "successor")
await mkdir(profile)
await mkdir(directory)
const executable = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
  .digest("hex")
const source = path.join(root, "source.ts")
const target = path.join(directory, "target.ts")
const module = path.resolve("src/kilocode/source-launch.ts")
const pipe = path.resolve("src/kilocode/source-pipe.ts")
await Bun.write(
  target,
  `import {observe} from ${JSON.stringify(module)}; import {receive} from ${JSON.stringify(pipe)}; import {createHash} from "node:crypto"; const root=${JSON.stringify(root)}; const ticket=await Bun.file(root+"/ticket.json").json(); const request=await Bun.file(root+"/accepted.json").json(); const observer=await observe(ticket); await Bun.write(root+"/observer-ready","ready"); await observer.done; const secret=await receive(request.pipe); await Bun.write(root+"/received.json",JSON.stringify({digest:createHash("sha256").update(secret).digest("hex")}));`,
)
const env = {
  HOME: directory,
  USERPROFILE: directory,
  KILO_TEST_HOME: directory,
  XDG_DATA_HOME: path.join(directory, "data"),
  XDG_CONFIG_HOME: path.join(directory, "config"),
  XDG_STATE_HOME: path.join(directory, "state"),
  XDG_CACHE_HOME: path.join(directory, "cache"),
  RAYA_DB: path.join(directory, "private.db"),
  KILO_DB: path.join(directory, "private.db"),
  RAYA_AUTH_CONTENT: "{}",
  KILO_AUTH_CONTENT: "{}",
  TEMP: path.join(directory, "tmp"),
  TMP: path.join(directory, "tmp"),
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
}
await Bun.write(
  source,
  `import {context,readHandoff,brokerCurrent,captureCurrent} from ${JSON.stringify(module)};const root=${JSON.stringify(root)}; const ticket=await context(); if(!ticket)throw new Error("No native context"); let request; while(!(request=await readHandoff(ticket)))await Bun.sleep(10); await Bun.write(root+"/accepted.json",JSON.stringify(request)); await brokerCurrent({expected:{executable:ticket.header.executable,digest:ticket.header.digest},request:request.id,directory:${JSON.stringify(directory)},args:[${JSON.stringify(target)}],env:${JSON.stringify(env)}}); await Bun.write(root+"/capture-entered","entered"); await captureCurrent();while(!(await Bun.file(root+"/release").exists()))await Bun.sleep(10);`,
)
const session = await launch({
  executable,
  digest,
  cwd: root,
  args: [source],
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  roots: [{ kind: "json", path: profile }],
  policy: { version: 1, directories: [profile.toLowerCase()], files: [] },
})
await Bun.write(path.join(root, "ticket.json"), JSON.stringify(session.ticket))
const output = [session.child.stdout, session.child.stderr].map(async (stream) => {
  if (!stream) throw new Error("Piped output required")
  const chunks: Buffer[] = []
  for await (const value of stream) {
    if (!Buffer.isBuffer(value)) throw new Error("Bad output")
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString()
})
const secret = "RAYA_TEST_PRIVATE_HANDOFF café 日本語 😀"
const server = await serve(secret, session.ticket.image)
const errors: unknown[] = []
let receiver: number | undefined
try {
  const id = randomUUID()
  const input = { id, pipe: { ...server.descriptor, server: { ...server.descriptor.server } } }
  const pending = session.handoff(input)
  assert.equal(session.handoff({ id, pipe: server.descriptor }), pending)
  input.pipe.server.digest = "0".repeat(64)
  await pending
  await assert.rejects(session.handoff({ id: randomUUID(), pipe: server.descriptor }))
  await session.start()
  const entered = Date.now() + 20000
  while (!(await Bun.file(path.join(root, "capture-entered")).exists())) {
    if (Date.now() > entered) throw new Error("Source never reached capture fence")
    await Bun.sleep(10)
  }
  await Bun.sleep(150)
  assert.equal(await Bun.file(session.ticket.control + ".source-capture-ready").exists(), false)
  assert.equal(session.child.exitCode, null)
  const observation = session.successor(id)
  assert.equal(session.successor(id), observation)
  await assert.rejects(session.successor(randomUUID()))
  const target = await observation
  receiver = target.pid
  assert.equal(target.digest, digest)
  assert.notEqual(receiver, session.ticket.header.pid)
  server.authorize(target)
  const deadline = Date.now() + 20000
  while (!(await Bun.file(path.join(root, "observer-ready")).exists())) {
    if (Date.now() > deadline) throw new Error("Successor observer did not acquire native helper")
    await Bun.sleep(10)
  }
  await Bun.write(path.join(root, "release"), "release")
  assert.equal((await session.retired()).familyZeroObserved, true)
  assert.equal((await server.done).receiver, receiver)
  const end = Date.now() + 10000
  const gone = z.object({ status: z.literal("gone"), birth: z.string().nullable(), parent: z.number() }).strict()
  while (!gone.safeParse(await NativeProcess.inspect(receiver)).success) {
    if (Date.now() > end) throw new Error("Exact successor did not exit")
    await Bun.sleep(20)
  }
  assert.equal(
    (await Bun.file(path.join(root, "received.json")).json()).digest,
    createHash("sha256").update(secret).digest("hex"),
  )
  const accepted = await Bun.file(path.join(root, "accepted.json")).text()
  assert.equal(accepted.includes(secret), false)
  const [stdout, stderr] = await Promise.all(output)
  assert.equal(stdout.includes(secret), false)
  assert.equal(stderr.includes(secret), false)
  await Bun.write(path.join(root, "stdout.log"), stdout)
  await Bun.write(path.join(root, "stderr.log"), stderr)
} catch (err) {
  errors.push(err)
} finally {
  await Bun.write(path.join(root, "release"), "release")
  await server.close().catch((err) => errors.push(err))
  if (session.child.exitCode === null) {
    await session.abort().catch((err) => errors.push(err))
    errors.push(new Error("Forced source cleanup"))
  }
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({
      passed: !errors.length,
      errors: errors.map(String),
      ticket: session.ticket,
      receiver,
      absent: !errors.length,
      secretPublished: false,
      portableCaptureAuthorized: false,
    }),
  )
}
if (errors.length) throw new AggregateError(errors, "Retained Core handoff fixture failure")
