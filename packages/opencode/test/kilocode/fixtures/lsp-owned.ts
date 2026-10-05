import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js"
import { createRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { closeProcessProfile, registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { create as admission } from "../../../src/kilocode/lsp/admission"
import { create as lua, extract } from "../../../src/kilocode/lsp/install"
import { command } from "../../../src/kilocode/lsp/process"
import { spawn } from "../../../src/lsp/launch"
import { LSPClient } from "../../../src/lsp/client"
import { withTestInstance, disposeTestRuntime } from "../../fixture/fixture"

const root = process.env.RAYA_LSP_OWNED_ROOT!
const mode = process.argv[2]
const bin = path.join(root, "bin")
const workspace = path.join(root, "workspace")
await fs.mkdir(bin, { recursive: true })
await fs.mkdir(workspace)
const registry = createRegistry()
const owner = admission(registry, registerProcessProfile, 30_000, ["expiry", "pipe"].includes(mode) ? 200 : 15_000)
const source = await fs.readFile(path.join(import.meta.dir, "lsp-owned-server.mjs"), "utf8")
const gate = ["expiry", "pipe"].includes(mode) ? path.join(root, "release") : ""
const zip = new ZipWriter(new Uint8ArrayWriter())
await zip.add("bin/lua-language-server.exe", new TextReader("disposable binary placeholder"))
await zip.add("fixture.mjs", new TextReader(source))
await zip.add("support/locale.txt", new TextReader("authentic supporting fixture"))
if (mode === "alias") await zip.add("bin/x:stream", new TextReader("refuse before extraction"))
const archive = Uint8Array.from(await zip.close())
if (mode === "expanded") {
  const central = Buffer.from(archive).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert(central >= 0)
  new DataView(archive.buffer).setUint32(central + 24, 300 * 1024 * 1024, true)
}
await fs.writeFile(path.join(root, "fixture.zip"), archive)
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const extracted = Promise.withResolvers<string>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/release")
      return Response.json({
        tag_name: "fixture",
        assets: [{ name: "lua-language-server-fixture-win32-x64.zip", browser_download_url: `${server.url}archive` }],
      })
    entered.resolve()
    if (mode === "download") await release.promise
    return new Response(Uint8Array.from(archive))
  },
})
const install = lua({
  owner,
  release: `${server.url}release`,
  async extract(file, dir, zip) {
    await extract(file, dir, zip)
    if (mode !== "foreign") return
    extracted.resolve(dir)
    await release.promise
  },
  launch: (_binary, cwd) => {
    return spawn(
      mode === "pipe" ? "node" : process.execPath,
      [path.join(bin, "lua-language-server-x64-win32", "fixture.mjs"), gate, mode],
      { cwd },
    )
  },
})
let failure: unknown
try {
  assert.equal(owner.snapshot().installed, false)
  assert.throws(() =>
    owner.open("relative", async () => {
      throw new Error("unreachable")
    }),
  )
  assert.equal(owner.snapshot().installed, false)
  const task = install(bin, workspace)
  if (mode === "foreign") {
    const stage = await extracted.promise
    await fs.rename(stage, stage + ".retained")
    await fs.mkdir(stage)
    await fs.writeFile(path.join(stage, "foreign.txt"), "must remain unchanged")
    release.resolve()
    await assert.rejects(task)
    assert.equal(await fs.readFile(path.join(stage, "foreign.txt"), "utf8"), "must remain unchanged")
    await assert.rejects(registry.drain())
  }
  if (["alias", "expanded"].includes(mode)) {
    await assert.rejects(task)
    assert.equal(owner.snapshot().active, 0)
    await assert.rejects(registry.drain())
  }
  if (!["alias", "expanded", "foreign"].includes(mode)) {
    if (mode === "download") {
      await entered.promise
      assert.equal(owner.snapshot().starts, 1)
      await assert.rejects(
        coordinateNativeRoots([{ kind: "json", path: bin }], async () => "unreachable", { timeoutMs: 80 }),
      )
      release.resolve()
    }
    const handle = await task
    assert.equal(owner.snapshot().active, 1)
    assert.equal(
      await fs.readFile(path.join(bin, "lua-language-server-x64-win32/support/locale.txt"), "utf8"),
      "authentic supporting fixture",
    )
    assert.equal((await fs.readdir(bin)).filter((name) => name.startsWith(".lua-")).length, 0)
    if (mode === "refuse") {
      await assert.rejects(
        withTestInstance({
          directory: workspace,
          fn: (ctx) =>
            LSPClient.create({
              serverID: "lua-ls",
              server: { process: handle.process, owner: handle },
              root: workspace,
              directory: workspace,
              instance: ctx,
            }),
        }),
      )
      await handle.close()
    } else {
      const client = await withTestInstance({
        directory: workspace,
        fn: (ctx) =>
          LSPClient.create({
            serverID: "lua-ls",
            server: { process: handle.process, owner: handle },
            root: workspace,
            directory: workspace,
            instance: ctx,
          }),
      })
      if (["expiry", "pipe"].includes(mode)) {
        await assert.rejects(client.shutdown(), /original ownership/)
        assert.equal(owner.snapshot().active, 1)
        assert.equal(owner.snapshot().fenced, true)
        if (mode === "pipe") assert.equal(handle.process.exitCode, 0)
        await assert.rejects(install(bin, workspace))
        const draining = owner.drain()
        let done = false
        void draining.then(
          () => {
            done = true
          },
          () => {
            done = true
          },
        )
        await sleep(20)
        assert.equal(done, false)
        await fs.writeFile(gate, "release")
        await assert.rejects(draining)
      } else await client.shutdown()
    }
    assert.equal(handle.process.exitCode, 0)
    await handle.joined
    assert.equal(owner.snapshot().active, 0)
    if (!["expiry", "pipe"].includes(mode)) await registry.drain()
  }
  assert.throws(() =>
    owner.open(bin, async () => {
      throw new Error("unreachable")
    }),
  )
  // Actual output-heavy child is drained rather than killed on the bounded-output error.
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(65536));process.stderr.write('y'.repeat(65536))",
  ])
  await assert.rejects(command(child, 1024))
  assert.equal(child.exitCode, 0)
} catch (err) {
  failure = err
} finally {
  release.resolve()
  if (gate) await fs.writeFile(gate, "release")
  await owner.drain().catch((err: unknown) => {
    if (!["expiry", "pipe", "alias", "expanded", "foreign"].includes(mode))
      failure = failure ? new AggregateError([failure, err]) : err
  })
  await server.stop()
  await disposeTestRuntime()
  await closeProcessProfile()
}
if (failure) throw failure
const captured = await coordinateNativeRoots([{ kind: "json", path: bin }], async () => true, { timeoutMs: 500 })
assert.equal(captured.value, true)
console.log(
  JSON.stringify({
    mode,
    passed: true,
    originalCode: ["alias", "expanded", "foreign"].includes(mode) ? null : 0,
    forced: false,
    snapshot: owner.snapshot(),
  }),
)
