import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { launch } from "../../../src/kilocode/source-launch"
import { NativeProcess } from "../../../src/kilocode/process-host"

const root = process.env.RAYA_SOURCE_INHERIT_TEST_ROOT!
const profile = path.join(root, "profile")
await mkdir(profile)
const file = path.join(root, "input.ts")
await Bun.write(
  file,
  `import {captureCurrent} from ${JSON.stringify(path.resolve("src/kilocode/source-launch.ts"))}; const input=await Bun.stdin.text(); await Bun.write(process.env.RAYA_SOURCE_INHERIT_TEST_ROOT+"/input-actual.json",JSON.stringify({value:input})); if(input!=="RAYA_INHERITED_INPUT café 日本語 😀") throw new Error("Inherited stdin changed"); console.log(input); await captureCurrent();`,
)
const executable = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
  .digest("hex")
const session = await launch({
  executable,
  digest,
  cwd: root,
  args: [file],
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  roots: [{ kind: "json", path: profile }],
  stdio: "inherit",
})
await session.start()
await Bun.write(path.join(root, "ready"), "ready")
assert.equal((await session.sourceExit).code, 0)
const proof = await session.retired()
assert.equal(proof.familyZeroObserved, true)
z.object({ status: z.literal("gone"), birth: z.string().nullable(), parent: z.number() })
  .strict()
  .parse(await NativeProcess.inspect(session.ticket.header.helper))
await Bun.write(
  path.join(root, "receipt.json"),
  JSON.stringify({
    passed: true,
    forced: false,
    consoleKeyboardVerified: false,
    ticket: session.ticket,
    portableCaptureAuthorized: false,
  }),
)
