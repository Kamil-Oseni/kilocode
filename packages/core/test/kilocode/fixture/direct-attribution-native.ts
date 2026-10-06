import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { finished } from "node:stream/promises"
import { launch } from "../../../src/kilocode/source-launch"
import { join } from "../../../src/kilocode/process-attribution"

async function main() {
  const helper = process.env.RAYA_MEMBER_DIAGNOSTIC_HELPER
  if (!helper) throw new Error("Private diagnostic helper required")
  const root = await mkdtemp(path.join(os.tmpdir(), "direct-join-"))
  const profile = path.join(root, "profile")
  await mkdir(profile)
  const file = path.join(root, "source.ts")
  const rows = path.join(root, "rows.json")
  const core = path.resolve(import.meta.dir, "../../..")
  const effect = path.resolve(core, "node_modules/effect/dist/index.js").replaceAll("\\", "/")
  const command = path.resolve(core, "node_modules/effect/dist/unstable/process/ChildProcess.js").replaceAll("\\", "/")
  const service = path
    .resolve(core, "node_modules/effect/dist/unstable/process/ChildProcessSpawner.js")
    .replaceAll("\\", "/")
  const layer = path.resolve(core, "src/effect/layer-node.ts").replaceAll("\\", "/")
  const spawner = path.resolve(core, "src/cross-spawn-spawner.ts").replaceAll("\\", "/")
  const diagnostic = path.resolve(core, "src/kilocode/direct-attribution.ts").replaceAll("\\", "/")
  await Bun.write(
    file,
    `
import { Effect } from ${JSON.stringify(effect)};
import * as ChildProcess from ${JSON.stringify(command)};
import { ChildProcessSpawner } from ${JSON.stringify(service)};
import { LayerNode } from ${JSON.stringify(layer)};
import { CrossSpawnSpawner } from ${JSON.stringify(spawner)};
import { records, footer } from ${JSON.stringify(diagnostic)};
await Effect.runPromise(Effect.gen(function*(){
 const service=yield* ChildProcessSpawner;
 const shell=yield* service.spawn(ChildProcess.make("echo",["synthetic"],{shell:true,stdout:"ignore",stderr:"ignore"}));
 yield* shell.exitCode;
 const child=yield* service.spawn(ChildProcess.make(process.execPath,["-e","setInterval(()=>{},10000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"}));
 yield* child.kill(); yield* child.exitCode;
}).pipe(Effect.scoped,Effect.provide(LayerNode.compile(CrossSpawnSpawner.node))));
await Bun.write(${JSON.stringify(rows)},JSON.stringify({rows:records(),footer:footer()}));
`,
  )
  const digest = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex")
  const app = await launch({
    executable: process.execPath,
    digest: await digest(process.execPath),
    helper: { executable: helper, digest: await digest(helper) },
    cwd: root,
    args: [file],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
      ),
      RAYA_SOURCE_MEMBER_DIAGNOSTICS: "1",
    },
    roots: [{ kind: "json", path: profile }],
    policy: { version: 1, directories: [root], files: [] },
  })
  const streams = Promise.all(
    [app.child.stdout, app.child.stderr].map((stream) => {
      if (!stream) throw new Error("Original stream absent")
      const closed = finished(stream)
      stream.resume()
      return closed
    }),
  )
  const state = { joined: false }
  const errors: unknown[] = []
  try {
    await app.start()
    const [source, code] = await Promise.all([app.sourceExit, app.exit, streams])
    state.joined = true
    assert.equal(source.code, 0)
    const family = await Bun.file(app.ticket.control + ".source-family-retired").json()
    assert.equal(code.code, 0)
    assert.equal(family.forced, false)
    assert.equal(family.memberObservationsComplete, true)
    assert.equal(family.memberObservationsOverflow, false)
    // Intentional owned cancellation remains nonzero, never converted into all-zero acceptance.
    assert.equal(
      family.members.some((member: { code: number }) => member.code !== 0),
      true,
    )
    const data = await Bun.file(rows).json()
    const native = await Bun.file(app.ticket.control + ".source-members-diagnostic").json()
    assert.equal(data.footer.recordsComplete, true)
    assert.equal(native.memberDropped, 0)
    assert.equal(native.memberConflicts, 0)
    for (const row of data.rows) {
      const member = join(row, native.members)
      assert.ok(member)
      assert.ok(member?.birth)
      assert.equal(
        family.members.some(
          (value: { pid: number; birth: string; code: number }) =>
            value.pid === member?.pid && value.birth === member?.birth && value.code === row.code,
        ),
        true,
      )
    }
    assert.equal(
      data.rows.some((row: { operation: string }) => row.operation === "taskkill"),
      true,
    )
  } catch (err) {
    errors.push(err)
  } finally {
    if (!state.joined) {
      const aborted = await Promise.allSettled([app.abort()])
      for (const result of aborted) if (result.status === "rejected") errors.push(result.reason)
    }
    const joined = await Promise.allSettled([app.sourceExit, app.exit, streams])
    for (const result of joined) if (result.status === "rejected") errors.push(result.reason)
  }
  if (errors.length)
    throw new AggregateError(errors, "Diagnostic fixture failed; original cleanup retained, no forced success credit")
}

await main()
