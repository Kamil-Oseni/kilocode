import assert from "node:assert/strict"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RipgrepBinary } from "../../../src/ripgrep/binary"
import { AppNodeBuilder } from "../../../src/effect/app-node-builder"
import { httpClient } from "../../../src/effect/app-node-platform"
import { Global } from "../../../src/global"
import { RuntimeRegistry } from "../../../src/kilocode/runtime-registry"
import { ripgrep } from "../../../src/kilocode/ripgrep-owner"
import { closeProcessProfile, processProfileSnapshot } from "../../../src/kilocode/process-profile"

const root = process.env.RAYA_RIPGREP_FIXTURE
assert.ok(root)
assert.equal(process.platform, "win32")
assert.equal(process.env.PSExecutionPolicyPreference, undefined)
async function policy() {
  const system = process.env.SystemRoot
  assert.ok(system)
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-ExecutionPolicy -List | ForEach-Object { [pscustomobject]@{scope=[string]$_.Scope;policy=[string]$_.ExecutionPolicy} } | ConvertTo-Json -Compress",
    ],
    {
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PSModulePath: path.join(system, "System32/WindowsPowerShell/v1.0/Modules") },
    },
  )
  const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  const output = await logs
  assert.equal(code, 0, output[1])
  return JSON.parse(output[0])
}
const before = await policy()
const mode = process.argv[2]
const bin = path.join(root, "bin")
await mkdir(bin)
Global.Path.bin = bin
const payload = Buffer.from("Actual disposable archive fixture: complete executable publication")
const directory = path.join(root, "archive", "ripgrep-15.1.0-x86_64-pc-windows-msvc")
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, "rg.exe"), payload)
const archive = path.join(root, "fixture.zip")
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const child = Bun.spawn(
  [
    "powershell.exe",
    "-ExecutionPolicy",
    "Bypass",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -LiteralPath ${quote(directory)} -DestinationPath ${quote(archive)}`,
  ],
  {
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
)
const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
const code = await child.exited
const logs = await output
assert.equal(code, 0, logs.join("\n"))
const bytes = mode === "corrupt" ? Buffer.from("invalid zip") : await readFile(archive)
const calls = { requests: 0 }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    calls.requests++
    return new Response(bytes)
  },
})
const adapter = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.mapRequest(client, (request) => HttpClientRequest.setUrl(request, server.url))
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
const first = ManagedRuntime.make(AppNodeBuilder.build(RipgrepBinary.node, [[httpClient, adapter]]))
const second = ManagedRuntime.make(AppNodeBuilder.build(RipgrepBinary.node, [[httpClient, adapter]]))
try {
  const a = await first.runPromise(RipgrepBinary.Service)
  const b = await second.runPromise(RipgrepBinary.Service)
  if (mode === "corrupt") {
    const exit = await first.runPromiseExit(a.filepath)
    assert.equal(exit._tag, "Failure")
    await assert.rejects(RuntimeRegistry.drain(), /Runtime ownership retirement failed/)
    assert.equal(ripgrep.snapshot().failures, 1)
    assert.equal(
      (await readdir(bin)).some(
        (name) => name.endsWith(".zip") || name.startsWith("ripgrep-") || name.endsWith(".tmp"),
      ),
      false,
    )
  } else {
    const files = await Promise.all([first.runPromise(a.filepath), second.runPromise(b.filepath)])
    assert.equal(files[0], files[1])
    assert.deepEqual(await readFile(files[0]), payload)
    assert.equal(calls.requests, 1)
    const next = path.join(root, "next")
    await mkdir(next)
    Global.Path.bin = next
    const target = await first.runPromise(a.filepath)
    assert.equal(target, path.join(next, "rg.exe"))
    assert.deepEqual(await readFile(target), payload)
    assert.equal(calls.requests, 2)
    await RuntimeRegistry.drain()
    assert.equal(ripgrep.snapshot().active, 0)
    for (const dir of [bin, next])
      assert.equal(
        (await readdir(dir)).some(
          (name) => name.endsWith(".zip") || name.startsWith("ripgrep-") || name.endsWith(".tmp"),
        ),
        false,
      )
  }
  assert.ok(processProfileSnapshot().roots.includes(bin))
  const marker = path.join(root, ".raya-profile-locks")
  const directories = (await readdir(marker)).filter((name) => name.endsWith(".owners"))
  const own = (
    await Promise.all(
      directories.map(async (dir) =>
        Promise.all(
          (await readdir(path.join(marker, dir))).map(async (name) => {
            const file = path.join(marker, dir, name)
            const record = JSON.parse(await readFile(file, "utf8"))
            return { file, record }
          }),
        ),
      ),
    )
  ).flat()
  assert.ok(own.some(({ record }) => record.pid === process.pid && record.root === bin.toLowerCase()))
  if (mode !== "corrupt")
    assert.ok(
      own.some(({ record }) => record.pid === process.pid && record.root === path.join(root, "next").toLowerCase()),
    )
  await closeProcessProfile()
  for (const { file } of own) assert.equal(await Bun.file(file).exists(), false)
  const after = await policy()
  assert.deepEqual(after, before)
  await writeFile(
    path.join(root, "receipt.json"),
    JSON.stringify({
      passed: true,
      mode,
      calls,
      archiveChildCode: code,
      participant: ripgrep.snapshot(),
      nativeMarkers: own.length,
      nativeMarkersRemoved: true,
      policy: { before, after, overrideAbsent: true },
    }),
  )
} finally {
  await Promise.all([first.dispose(), second.dispose()])
  await server.stop(true)
}
