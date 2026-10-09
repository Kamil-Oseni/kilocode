import path from "node:path"
import { copyFile, mkdir, readFile, writeFile, lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { BrainSettings } from "../../../src/second-brain/settings"
import { descriptor } from "../../../src/second-brain/managed/descriptor"
import { Pair } from "../../../src/second-brain/managed/pair"
import { Pipes, publish } from "../../../src/second-brain/managed/owner"
import { command } from "../../../src/second-brain/control/command"
import { interpreter } from "../../../src/second-brain/managed/catalog"
import { image, observe } from "../../../src/second-brain/control/identity"
import { packaged } from "../../../src/second-brain/control/index"
import { spawn } from "../../../src/util/process"
import { runtime } from "./native-memory-runtime"
import { release } from "../../../src/second-brain/control/catalog-capture"
import { sha } from "../../../src/second-brain/control/frames"

const base = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
const full = process.argv.includes("--runtime")
const cancelled = process.argv.includes("--cancelled-search")
const source = full ? await mkdtemp(path.join(tmpdir(), "raya-original-capture-source-")) : undefined
if (source) {
  for (const name of Object.keys(release))
    await copyFile(path.resolve("script/memory/service", name), path.join(source, name))
  for (const [name, hash] of Object.entries({
    "server.py": "8764ed7600cefb9a33684e06d35ca82df8b408284849fb47442701e9b164443c",
    "index.py": "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e",
  })) {
    const child = Bun.spawn(
      ["git", "show", "5a4e669f0803ff5a52e22da85a69f5346ceeba41:packages/kilo-vscode/script/memory/service/" + name],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [raw, errors, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0 || errors || sha(Buffer.from(raw)) !== hash)
      throw new Error("Exact original capture source blob required")
    await writeFile(path.join(source, name), Buffer.from(raw))
  }
}
const prepared = await command(
  "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
  [
    "-B",
    path.resolve(cancelled ? "script/memory/cancelled_search_producer.py" : "script/memory/capture_recovery_test.py"),
    "--prepare",
    ...(source ? ["--source", source] : []),
  ],
  { cwd: process.cwd() },
)
const data = JSON.parse(prepared.stdout) as {
  root: string
  notes: string
  operations: string
  cfg: { source: string; pins: Record<string, string>; turn: Record<string, string> }
  result: {
    operation: { request: string; owner_epoch: string; selected_release_sha256: string; request_sha256: string }
  }
}
const native = full ? await runtime(data.root, { path: data.cfg.source, pins: data.cfg.pins }, data.notes) : undefined
const root = native?.cfg.root ?? path.join(data.root, "raya-memory-managed-recovery")
if (!native) {
  await mkdir(path.join(root, "memory", "Runs"), { recursive: true })
  await mkdir(path.join(root, "source", "memory"), { recursive: true })
  for (const name of Object.keys(data.cfg.pins))
    await copyFile(path.join(data.cfg.source, name), path.join(root, "source", "memory", name))
  await copyFile(path.resolve("script/memory/supervise.py"), path.join(root, "supervise.py"))
  await writeFile(
    path.join(root, "memory.json"),
    JSON.stringify({ source: path.join(root, "source", "memory"), source_sha256: data.cfg.pins }),
  )
  await writeFile(path.join(root, "retrieval.json"), JSON.stringify({ port: 58742 }))
}
if (source) {
  if (
    path.dirname(source) !== path.resolve(tmpdir()) ||
    !path.basename(source).startsWith("raya-original-capture-source-")
  )
    throw new Error("Owned source fixture path required")
  await rm(source, { recursive: true })
}
const ref = async (file: string) => {
  const held = await image(file, 16777216)
  return { path: file, bytes: held.raw.length, sha256: held.digest }
}
const space = (kind: string) => ({
  root: path.join(root, kind),
  sid: "S-1-5-21-1-2-3-1001",
  generations: { root: ["1", "2", "3"], Runs: ["4", "5", "6"], Requests: ["7", "8", "9"] },
})
const cfg =
  native?.cfg ??
  descriptor({
    format: "raya.memory.managed.launch",
    version: 2,
    root,
    python: await ref(base),
    supervisor: await ref(path.join(root, "supervise.py")),
    plan: await ref(path.join(root, "memory.json")),
    retrieval: await ref(path.join(root, "retrieval.json")),
    namespaces: { memory: space("memory"), retrieval: space("retrieval") },
  })
const python = cfg.python.path
const file = path.join(data.root, "host.json")
await writeFile(file, "{}")
const settings = new BrainSettings(
  {
    get<T>(key: string) {
      return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
    },
    async update(key, value) {
      const data = JSON.parse(await readFile(file, "utf8"))
      data[key] = value
      await writeFile(file, JSON.stringify(data))
    },
  },
  {
    async get() {
      return "synthetic"
    },
    async store() {},
    async delete() {},
  },
)
await settings.save(
  {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v2",
    origin: "http://127.0.0.1:58741",
    root: data.notes,
    source_sha256: data.cfg.pins,
  },
  "synthetic",
  cfg,
)
const loaded = (await settings.load())!
const record = settings.managed(loaded.setup)
const stat = await lstat(root, { bigint: true })
const images = await Promise.all(
  [cfg.python, cfg.supervisor, cfg.plan, cfg.retrieval!].map(async (ref) => {
    const held = await image(ref.path, 16777216)
    return { ref, sha256: held.digest, tuple: held.tuple }
  }),
)
const selected = await publish(path.join(root, "managed-reservation.json"), {
  format: "raya.memory.managed.pair.selected",
  version: 2,
  descriptor: cfg,
  rootIdentity: [stat.dev, stat.ino, stat.birthtimeNs].map(String),
  images,
  containment: "Synthetic original nonmodel process/stream closure only",
})
await record("selected", selected)
const pair = new Pair()
const helper = await packaged(process.cwd())
const originals: Record<string, unknown> = {}
let original!: Awaited<ReturnType<typeof publish>>
const body = `import sys,json
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'launch-selected'}),flush=True)
assert sys.stdin.buffer.readline(8)==b'START\\n'
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'uvicorn-started'}),flush=True)
assert sys.stdin.buffer.readline(8) in (b'STOP\\n',b'')
print(json.dumps({'format':'raya.memory.disposable.supervisor.closed','passed':True,'errors':[],'control_joined':True}),flush=True)
`
await pair.start(
  async (kind) => {
    const child = spawn(python, ["-I", "-S", "-B", "-u", "-c", body], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const pipes = new Pipes(child)
    pair.hold(kind, pipes)
    await pipes.ready("launch-selected")
    const identity = await observe(child, python, helper.helper, interpreter)
    originals[kind] = await publish(path.join(root, `managed-${kind}-original.json`), {
      format: "raya.memory.managed.pair.original",
      version: 2,
      kind,
      selected,
      identity,
      imageObservation: "Actual selected native process image",
      nativeFamilyRetirement: false,
    })
    await pipes.start()
    await pipes.ready("uvicorn-started")
  },
  async () => {
    original = await publish(path.join(root, "managed-original.json"), {
      format: "raya.memory.managed.pair.originals",
      version: 2,
      selected,
      originals,
    })
    await record("running", original)
  },
)
const closures = await pair.close()
await publish(path.join(root, "managed-closed.json"), {
  format: "raya.memory.managed.pair.closed",
  version: 2,
  selected,
  original,
  closures,
  qualification: "Actual nonmodel originals/streams only, no native-family or cold settlement authority",
})
const operation = data.result.operation
const folder = path.join(cfg.namespaces.memory.root, "Requests", operation.owner_epoch)
await mkdir(folder, { recursive: true })
for (const phase of ["pending", "terminal"])
  await copyFile(
    path.join(data.operations, operation.request + "-" + phase + ".json"),
    path.join(folder, operation.request + "-" + phase + ".json"),
  )
await settings.record({
  format: "raya.memory.control.uncertainty",
  version: 2,
  protocol: loaded.setup.version === 2 ? loaded.setup.protocol : "",
  root: data.notes,
  request: {
    op: cancelled ? "search" : "capture",
    id: operation.request,
    root: data.notes,
    owner_epoch: operation.owner_epoch,
    selected_release_sha256: operation.selected_release_sha256,
    bodySHA: operation.request_sha256,
    source_sha256: data.cfg.pins,
  },
})
const turn = { ...data.cfg.turn, root: data.notes, release: operation.selected_release_sha256, phase: "uncertain" }
const state = JSON.parse(await readFile(file, "utf8"))
state["raya.secondBrain.personalCapture.turns"] = [turn]
await writeFile(file, JSON.stringify(state))
console.log(JSON.stringify({ root: data.root, notes: data.notes, file, turn, producer: prepared.receipt }))
