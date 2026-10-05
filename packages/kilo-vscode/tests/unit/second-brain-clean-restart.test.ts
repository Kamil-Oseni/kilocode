import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "../../src/util/process"
import { BrainSettings } from "../../src/second-brain/settings"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { interpreter, supervisor } from "../../src/second-brain/managed/catalog"
import { Pair } from "../../src/second-brain/managed/pair"
import { Pipes, publish } from "../../src/second-brain/managed/owner"
import { launch, history, transition } from "../../src/second-brain/managed/restart"
import { protect } from "../../src/second-brain/control/protection"
import { observe } from "../../src/second-brain/control/identity"
import { packaged } from "../../src/second-brain/control/index"
import { release } from "../../src/second-brain/control/catalog-v2"

const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
// Controlled nonmodel producer; actual Pipes observes the original process and both readers.
const body = `import sys,json
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'launch-selected'}),flush=True)
assert sys.stdin.buffer.readline(8)==b'START\\n'
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'uvicorn-started'}),flush=True)
assert sys.stdin.buffer.readline(8) in (b'STOP\\n',b'')
print(json.dumps({'format':'raya.memory.disposable.supervisor.closed','passed':True,'errors':[],'control_joined':True}),flush=True)
`

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-memory-control-restart-"))
  await protect(root)
  await mkdir(path.join(root, "memory", "Runs"), { recursive: true })
  const file = path.join(root, "settings.json")
  await writeFile(file, "{}")
  const secrets = new Map<string, string>()
  const settings = () =>
    new BrainSettings(
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
        async get(key) {
          return secrets.get(key)
        },
        async store(key, value) {
          secrets.set(key, value)
        },
        async delete(key) {
          secrets.delete(key)
        },
      },
    )
  const ref = (name: string, sha256: string) => ({ path: path.join(root, name), bytes: 1, sha256 })
  const space = (kind: string) => ({
    root: path.join(root, kind),
    sid: "S-1-5-21-1-2-3-1001",
    generations: { root: ["1", "2", "3"], Runs: ["4", "5", "6"], Requests: ["7", "8", "9"] },
  })
  const cfg = descriptor({
    format: "raya.memory.managed.launch",
    version: 2,
    root,
    python: { path: python, bytes: Number((await lstat(python)).size), sha256: interpreter },
    supervisor: ref("supervise.py", supervisor),
    plan: ref("memory.json", "a".repeat(64)),
    retrieval: ref("retrieval.json", "b".repeat(64)),
    namespaces: { memory: space("memory"), retrieval: space("retrieval") },
  })
  const setup = {
    format: "raya.memory.setup" as const,
    version: 2 as const,
    protocol: "raya.memory.operation.v1" as const,
    origin: "http://127.0.0.1:58741",
    root: "C:\\Synthetic\\Notes",
    source_sha256: release,
  }
  const first = settings()
  await first.save(setup, "synthetic", cfg)
  const loaded = await first.load()
  const record = first.managed(loaded!.setup)
  const stat = await lstat(root, { bigint: true })
  const selected = await publish(path.join(root, "managed-reservation.json"), {
    format: "raya.memory.managed.pair.selected",
    version: 2,
    descriptor: cfg,
    rootIdentity: [stat.dev, stat.ino, stat.birthtimeNs].map(String),
    images: [cfg.python, cfg.supervisor, cfg.plan, cfg.retrieval].map((ref) => ({
      ref,
      sha256: ref!.sha256,
      tuple: "1:2:1:1:3:4",
    })),
    containment: "two original processes and their pipes only",
  })
  await record("selected", selected)
  const pair = new Pair()
  const helper = await packaged(path.resolve("."))
  const originals: Record<string, unknown> = {}
  let original!: Awaited<ReturnType<typeof publish>>
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
        imageObservation: "selected image and CIM path",
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
  const closed = await publish(path.join(root, "managed-closed.json"), {
    format: "raya.memory.managed.pair.closed",
    version: 2,
    selected,
    original,
    closures,
    qualification: "Original process/streams only; no downstream cold settlement authority",
  })
  await record("closed", closed)
  return {
    root,
    cfg,
    setup,
    file,
    settings,
    closed,
    selected,
    async cleanup() {
      await pair.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("new host authenticates two naturally joined originals and computes one create-new successor, preserving closed history", async () => {
  const value = await fixture()
  try {
    const before = await readFile(value.file)
    const host = value.settings()
    const a = await host.load()
    const b = await value.settings().load()
    expect(a!.launch).toEqual(b!.launch)
    expect(a!.launch!.predecessor).toEqual(value.closed)
    expect(await readFile(value.file)).toEqual(before)
    const attempts = await Promise.allSettled([mkdir(a!.launch!.root), mkdir(b!.launch!.root)])
    expect(attempts.filter((row) => row.status === "fulfilled").length).toBe(1)
    expect(attempts.filter((row) => row.status === "rejected").length).toBe(1)
    // Crash before Settings publication leaves the same deterministic reservation unavailable.
    const cold = await value.settings().load()
    await expect(mkdir(cold!.launch!.root)).rejects.toThrow()
    expect(await readFile(value.file)).toEqual(before)
    expect(history(undefined, value.closed)).toEqual([value.closed])
    expect(() => history([value.closed], value.closed)).toThrow()
    expect(() => transition("uncertain", "selected", a!.launch, value.closed)).toThrow()
    expect(() => transition("running", "selected", a!.launch, value.closed)).toThrow()
    const record = host.managed(a!.setup)
    const derived = descriptor({
      ...value.cfg,
      plan: { ...value.cfg.plan, path: path.join(a!.launch!.root, "memory-plan.json") },
      retrieval: { ...value.cfg.retrieval!, path: path.join(a!.launch!.root, "retrieval-plan.json") },
      namespaces: {
        memory: { ...value.cfg.namespaces.memory, root: path.join(a!.launch!.root, "memory") },
        retrieval: { ...value.cfg.namespaces.retrieval, root: path.join(a!.launch!.root, "retrieval") },
      },
    })
    const selected = await publish(path.join(a!.launch!.root, "managed-reservation.json"), {
      format: "raya.memory.managed.pair.selected",
      version: 2,
      descriptor: derived,
      predecessor: value.closed,
    })
    await expect(record("selected", selected)).rejects.toThrow("descriptor required")
    await record("selected", selected, derived)
    const saved = JSON.parse(await readFile(value.file, "utf8"))["raya.secondBrain.setup"]
    expect(saved.managed).toEqual(derived)
    expect(saved.launch.history).toEqual([value.closed])
    // Metadata transition coverage only; this is not a second model-bearing original launch proof.
    await record("running", selected)
    expect(JSON.parse(await readFile(value.file, "utf8"))["raya.secondBrain.setup"].managed).toEqual(derived)
    await expect(value.settings().load()).rejects.toThrow("retained")
  } finally {
    await value.cleanup()
  }
}, 30000)

test("cold closed-chain refuses changed original images and pending control debt without replay or writes", async () => {
  const value = await fixture()
  try {
    const before = await readFile(value.file)
    for (const phase of ["selected", "running", "uncertain"]) {
      const stored = JSON.parse(before.toString())
      stored["raya.secondBrain.setup"].launch.phase = phase
      await writeFile(value.file, JSON.stringify(stored))
      const retained = await readFile(value.file)
      await expect(value.settings().load()).rejects.toThrow("retained")
      expect(await readFile(value.file)).toEqual(retained)
    }
    await writeFile(value.file, before)
    const stored = JSON.parse(before.toString())
    stored["raya.secondBrain.control.uncertainty"] = {
      format: "raya.memory.control.uncertainty",
      version: 2,
      protocol: value.setup.protocol,
      root: value.setup.root,
      request: {
        op: "search",
        id: "b".repeat(32),
        root: value.setup.root,
        owner_epoch: "c".repeat(32),
        selected_release_sha256: "d".repeat(64),
        bodySHA: "e".repeat(64),
        source_sha256: release,
      },
    }
    await writeFile(value.file, JSON.stringify(stored))
    const blocked = await readFile(value.file)
    await expect(value.settings().load()).rejects.toThrow("pending original settlement")
    expect(await readFile(value.file)).toEqual(blocked)
    await writeFile(value.file, before)
    await writeFile(value.selected.path, "{}")
    await expect(launch(value.cfg, value.setup, value.closed)).rejects.toThrow()
    await expect(value.settings().load()).rejects.toThrow()
    expect(await readFile(value.file)).toEqual(before)
  } finally {
    await value.cleanup()
  }
}, 30000)
