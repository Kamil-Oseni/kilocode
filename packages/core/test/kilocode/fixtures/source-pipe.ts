import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { serve } from "../../../src/kilocode/source-pipe"
import { NativeProcess } from "../../../src/kilocode/process-host"

const root = process.env.RAYA_SOURCE_PIPE_TEST_ROOT!
const mode = process.argv[2]
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const pin = {
  executable: process.execPath,
  digest: hash(new Uint8Array(await Bun.file(process.execPath).arrayBuffer())),
}
const owned = z.object({ status: z.literal("owned"), birth: z.string(), parent: z.number() }).strict()
const own = owned.parse(await NativeProcess.inspect(process.pid))
const secret = "Raya private test café 日本語 😀"
const server = await serve(secret, undefined, 2500)
const errors: unknown[] = []
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
try {
  const file = path.join(root, "receiver.ts")
  await Bun.write(
    file,
    `import { receive } from ${JSON.stringify(path.resolve("src/kilocode/source-pipe.ts"))}; import {createHash} from "node:crypto";
const root=process.env.RAYA_SOURCE_PIPE_TEST_ROOT!; while(!(await Bun.file(root+"/go").exists())) await Bun.sleep(10);
const descriptor=await Bun.file(root+"/descriptor.json").json(); const value=await receive(descriptor,undefined,2500);
await Bun.write(root+"/received.json", JSON.stringify({digest:createHash("sha256").update(value).digest("hex")}));`,
  )
  await Bun.write(
    path.join(root, "descriptor.json"),
    JSON.stringify(
      mode === "wrongserver"
        ? {
            ...server.descriptor,
            server: { ...server.descriptor.server, birth: String(BigInt(server.descriptor.server.birth) + 1n) },
          }
        : server.descriptor,
    ),
  )
  if (mode === "timeout") {
    server.authorize({ pid: process.pid, birth: own.birth, ...pin })
    await assert.rejects(server.done)
  } else {
    child = Bun.spawn([process.execPath, file], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: process.env,
    })
    const identity = owned.parse(await NativeProcess.inspect(child.pid))
    server.authorize({
      pid: mode === "wrongclient" ? process.pid : child.pid,
      birth: mode === "wrongclient" ? own.birth : identity.birth,
      ...pin,
    })
    await Bun.write(path.join(root, "go"), "go")
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(root, "receiver.stdout.log"), stdout)
    await Bun.write(path.join(root, "receiver.stderr.log"), stderr)
    assert.equal(stdout.includes(secret), false)
    assert.equal(stderr.includes(secret), false)
    if (mode === "accepted") {
      assert.equal(code, 0)
      const result = await server.done
      assert.equal(result.receiver, child.pid)
      assert.equal((await Bun.file(path.join(root, "received.json")).json()).digest, hash(secret))
    } else {
      assert.notEqual(code, 0)
      await assert.rejects(server.done)
      assert.equal(await Bun.file(path.join(root, "received.json")).exists(), false)
    }
  }
} catch (err) {
  errors.push(err)
} finally {
  await server.close().catch((err) => {
    if (mode === "accepted") errors.push(err)
  })
  if (child && child.exitCode === null) {
    child.kill()
    errors.push(new Error("Fixture forced receiver cleanup"))
    await child.exited
  }
  const gone = z.object({ status: z.literal("gone"), birth: z.string().nullable(), parent: z.number() }).strict()
  gone.parse(await NativeProcess.inspect(server.descriptor.server.pid))
  if (child) gone.parse(await NativeProcess.inspect(child.pid))
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({
      passed: !errors.length,
      errors: errors.map(String),
      descriptor: server.descriptor,
      absent: true,
      secretPublished: false,
      portableCaptureAuthorized: false,
    }),
  )
}
if (errors.length) throw new AggregateError(errors, "Retained private pipe fixture failure")
