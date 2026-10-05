import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import { launch, observe, memberContext } from "../../../src/kilocode/source-launch"

const root = process.env.RAYA_SOURCE_LAUNCH_TEST_ROOT!
const mode = process.argv[2] ?? "held"
const profile = path.join(root, "profile")
await mkdir(profile)
const command = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(command).arrayBuffer()))
  .digest("hex")
const file = path.join(root, "body.ts")
await Bun.write(
  file,
  `import { context, captureCurrent, memberContext } from ${JSON.stringify(path.resolve("src/kilocode/source-launch.ts"))}
import {spawn} from "node:child_process";
const root = process.env.RAYA_SOURCE_LAUNCH_TEST_ROOT!
const mode = process.argv[2]
const ticket = await context()
if (!ticket || ticket.header.pid !== process.pid) throw new Error("Context did not belong to exact source")
await Bun.write(root + "/context.json", JSON.stringify(ticket))
if(mode === "member") {
  if((await memberContext())?.header.pid !== process.pid) throw new Error("Root membership refused");
  const code = ${JSON.stringify(`import { memberContext, context } from ${JSON.stringify(path.resolve("src/kilocode/source-launch.ts"))}; const ticket=await memberContext(); if(!ticket || ticket.header.pid === process.pid) throw new Error("Descendant not recognized"); await context().then(()=>{throw new Error("Descendant acquired root authority")},()=>{}); await Bun.write(process.env.RAYA_SOURCE_LAUNCH_TEST_ROOT+"/member.json",JSON.stringify({member:true,pid:process.pid}));`)};
  const child=Bun.spawn([process.execPath,"-e",code],{stdin:"ignore",stdout:"ignore",stderr:"inherit",env:process.env}); if(await child.exited !== 0) throw new Error("Descendant membership failed");
}
if(mode === "rootexit") {
  const code = "const root=process.env.RAYA_SOURCE_LAUNCH_TEST_ROOT; await Bun.write(root+'/child-ready','ready'); while(!(await Bun.file(root+'/family-release').exists())) await Bun.sleep(10); await Bun.write(root+'/child-final','closed');";
  const child=spawn(process.execPath,["-e",code],{stdio:"ignore",detached:true,env:process.env,windowsHide:true}); child.unref(); while(!(await Bun.file(root+'/child-ready').exists())) await Bun.sleep(10);
}
if (mode === "nonzero") {
  const tool = Bun.spawn([process.execPath, "-e", "await Bun.sleep(200); process.exit(7)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env, windowsHide: true })
  if (await tool.exited !== 7) throw new Error("Actual tool did not return its diagnostic exit")
}
if (mode !== "missingack") await captureCurrent()
while (!(await Bun.file(root + "/release").exists())) await Bun.sleep(10)
await Bun.write(root + "/final-marker", "RAYA_SOURCE_FINAL_MARKER")
`,
)
const session = await launch({
  executable: command,
  digest,
  cwd: root,
  args: [file, mode],
  env: { ...process.env, RAYA_SOURCE_LAUNCH_TEST_ROOT: root } as Record<string, string>,
  roots: [{ kind: "json", path: profile }],
  ...(mode === "policy" ? { policy: { version: 1 as const, directories: [profile.toLowerCase()], files: [] } } : {}),
})
const collect = async (stream: Readable | null) => {
  if (!stream) throw new Error("Source fixture requires piped output")
  const chunks: Buffer[] = []
  for await (const value of stream) {
    if (!Buffer.isBuffer(value)) throw new Error("Unexpected source output encoding")
    chunks.push(value)
    if (chunks.reduce((size, chunk) => size + chunk.length, 0) > 16384)
      throw new Error("Source fixture output exceeded bound")
  }
  return Buffer.concat(chunks).toString()
}
const output = [collect(session.child.stdout), collect(session.child.stderr)]
const errors: unknown[] = []
let observer: Awaited<ReturnType<typeof observe>> | undefined
try {
  assert.equal(session.ticket.header.pid === process.pid, false)
  assert.equal(await Bun.file(path.join(root, "context.json")).exists(), false)
  if (mode === "wrongticket")
    await assert.rejects(
      observe({
        ...session.ticket,
        header: { ...session.ticket.header, helperBirth: String(BigInt(session.ticket.header.helperBirth) + 1n) },
      }),
    )
  observer = await observe(session.ticket)
  await session.start()
  const end = Date.now() + 15000
  while (!(await Bun.file(path.join(root, "context.json")).exists())) {
    if (Date.now() >= end) throw new Error("Source context never published")
    await Bun.sleep(10)
  }
  if (mode === "member") {
    const previous = Object.fromEntries(
      ["CONTROL", "TOKEN", "HELPER", "DIGEST"].map((name) => [
        `RAYA_SOURCE_JOB_${name}`,
        process.env[`RAYA_SOURCE_JOB_${name}`],
      ]),
    )
    try {
      Object.assign(process.env, {
        RAYA_SOURCE_JOB_CONTROL: session.ticket.control,
        RAYA_SOURCE_JOB_TOKEN: session.ticket.token,
        RAYA_SOURCE_JOB_HELPER: session.ticket.image.executable,
        RAYA_SOURCE_JOB_DIGEST: session.ticket.image.digest,
      })
      await assert.rejects(memberContext())
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
  let settled = false
  void observer.done.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Bun.sleep(150)
  assert.equal(settled, false)
  if (mode === "forced") {
    const result = await session.abort()
    assert.equal(result.forced, true)
    await assert.rejects(observer.done)
    await assert.rejects(session.retired())
  } else {
    await Bun.write(path.join(root, "release"), "release")
    if (mode === "rootexit") {
      assert.equal((await session.sourceExit).code, 0)
      assert.equal(settled, false)
      assert.equal(await Bun.file(path.join(root, "child-final")).exists(), false)
      await Bun.write(path.join(root, "family-release"), "release")
    }
    if (mode === "missingack") await assert.rejects(observer.done)
    else {
      const proof = await observer.done
      assert.equal(proof.portableCaptureAuthorized, false)
      assert.equal(proof.familyZeroObserved, true)
      assert.equal((await session.sourceExit).code, 0)
      if (mode === "policy") {
        assert.equal(proof.ticket.header.version, 2)
        assert.deepEqual(proof.ticket.header.policy?.directories, [profile.toLowerCase()])
      }
      if (mode === "nonzero")
        assert.ok(proof.members.some((member) => member.code === 7) || !proof.memberObservationsComplete)
      assert.equal((await session.exit).code, 0)
    }
    assert.equal(await Bun.file(path.join(root, "final-marker")).text(), "RAYA_SOURCE_FINAL_MARKER")
  }
} catch (err) {
  errors.push(err)
} finally {
  await Bun.write(path.join(root, "release"), "release")
  await Bun.write(path.join(root, "family-release"), "release")
  await observer?.close()
  const [stdout, stderr] = await Promise.all(output)
  await Bun.write(path.join(root, "stdout.log"), stdout)
  await Bun.write(path.join(root, "stderr.log"), stderr)
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({
      passed: errors.length === 0,
      errors: errors.map(String),
      ticket: session.ticket,
      exit: await session.exit,
      portableCaptureAuthorized: false,
    }),
  )
}
if (errors.length) throw new AggregateError(errors, `Retained source launcher failure ${root}`)
