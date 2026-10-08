import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
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
import { fingerprint } from "../../src/second-brain/failed-repair"
import { images, fingerprint as reusable } from "../../src/second-brain/managed/reuse-catalog"
import { image } from "../../src/second-brain/control/identity"
import { review as archive, absent } from "../../src/second-brain/failed-archive"
import { review as closure, ClosedRequired } from "../../src/second-brain/closed-recovery"

test("missed shutdown publication recovers only the exact closed pair after its original parent exits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-closed-pair-parent-"))
  const runner = path.join(dir, "producer.ts")
  const source = await readFile(import.meta.filename, "utf8")
  const imports = source.slice(source.indexOf("\nconst python ="), source.indexOf("\nasync function failed("))
  const header = source
    .slice(0, source.indexOf('test("missed shutdown'))
    .replace(/from "(\.[^"]+)"/g, (_, name: string) => `from ${JSON.stringify(path.resolve(import.meta.dir, name))}`)
  await writeFile(
    runner,
    header +
      imports +
      "\nconst value = await fixture(); console.log(JSON.stringify({root:value.root,file:value.file,running:value.running,closed:value.closed}));\n",
  )
  const child = Bun.spawn([process.execPath, runner], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  const value = JSON.parse(out) as {
    root: string
    file: string
    running: object
    closed: { path: string; sha256: string }
  }
  const storage = {
    get<T>(key: string) {
      return JSON.parse(readFileSync(value.file, "utf8"))[key] as T | undefined
    },
    async update(key: string, item: unknown) {
      const data = JSON.parse(await readFile(value.file, "utf8"))
      data[key] = item
      await writeFile(value.file, JSON.stringify(data))
    },
  }
  const cfg = new BrainSettings(storage, {
    async get() {
      return "synthetic"
    },
    async store() {},
    async delete() {},
  })
  const key = "raya.secondBrain.setup"
  try {
    await storage.update(key, value.running)
    const reviewed = await closure(value.running as Parameters<typeof closure>[0])
    expect(reviewed.pids).toContain(child.pid)
    expect((await absent(reviewed)).helper.code).toBe(0)
    await cfg.resume(async () => false)
    expect(storage.get(key)).toEqual(value.running)
    const original = await readFile(value.closed.path)
    const missing = value.closed.path + ".retained"
    await rename(value.closed.path, missing)
    await expect(cfg.load()).rejects.toBeInstanceOf(ClosedRequired)
    expect(storage.get(key)).toEqual(value.running)
    await rename(missing, value.closed.path)
    await writeFile(value.closed.path, original.toString().replace('"code":0', '"code":1'))
    await expect(cfg.load()).rejects.toBeInstanceOf(ClosedRequired)
    await expect(cfg.resume(async () => true)).rejects.toThrow()
    expect(storage.get(key)).toEqual(value.running)
    await writeFile(value.closed.path, original)
    // Restoring bytes changes the tuple, so derive a fresh exact review rather than reuse prior authority.
    const loaded = await Promise.all([cfg.load(), cfg.load()])
    expect(loaded.map((item) => item?.launch?.predecessor?.sha256)).toEqual([value.closed.sha256, value.closed.sha256])
    expect(storage.get<{ launch: { phase: string } }>(key)?.launch.phase).toBe("closed")
    expect(cfg.pending()).toBeUndefined()
    const audit = storage.get<{ previous: unknown; requestSettlement: boolean; phase: string }>(
      `raya.secondBrain.closedPairRecovery.${value.closed.sha256}`,
    )
    expect(audit?.previous).toEqual(value.running)
    expect(audit?.requestSettlement).toBe(false)
    expect(audit?.phase).toBe("applied")
    expect((await cfg.load())?.launch?.predecessor?.sha256).toBe(value.closed.sha256)
  } finally {
    expect(path.dirname(value.root)).toBe(path.resolve(tmpdir()))
    await rm(value.root, { recursive: true, force: true })
    expect(path.dirname(dir)).toBe(path.resolve(tmpdir()))
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)

const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
// Controlled nonmodel producer; actual Pipes observes the original process and both readers.
const body = `import sys,json
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'launch-selected'}),flush=True)
assert sys.stdin.buffer.readline(8)==b'START\\n'
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'uvicorn-started'}),flush=True)
assert sys.stdin.buffer.readline(8) in (b'STOP\\n',b'')
print(json.dumps({'format':'raya.memory.disposable.supervisor.closed','passed':True,'errors':[],'control_joined':True}),flush=True)
`

async function fixture(
  protocol: "raya.memory.operation.v1" | "raya.memory.operation.v2" = "raya.memory.operation.v1",
  hook?: (key: string, value: unknown) => Promise<void>,
) {
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
          await hook?.(key, value)
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
    protocol,
    origin: "http://127.0.0.1:58741",
    root,
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
  const running = JSON.parse(await readFile(file, "utf8"))["raya.secondBrain.setup"]
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
    running,
    async cleanup() {
      await pair.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function failed(value: Awaited<ReturnType<typeof fixture>>) {
  const child = Bun.spawn(
    [
      python,
      "-I",
      "-S",
      "-B",
      path.join(import.meta.dir, "fixtures/memory-client-v2-producer.py"),
      path.join(import.meta.dir, "../../script/memory/service"),
      JSON.stringify(release),
    ],
    { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  expect(err).toBe("")
  const item = JSON.parse(out).cases.find((row: { name: string }) => row.name === "search-failed-empty-v2")
  const terminal = JSON.parse(Buffer.from(item.terminal, "base64").toString())
  const debt = {
    format: "raya.memory.control.uncertainty",
    version: 2,
    protocol: value.setup.protocol,
    root: value.setup.root,
    request: {
      op: "search",
      id: item.selected.request,
      root: value.setup.root,
      owner_epoch: item.selected.epoch,
      selected_release_sha256: item.selected.release,
      bodySHA: item.selected.digest,
      source_sha256: release,
    },
  }
  const folder = path.join(value.cfg.namespaces.memory.root, "Requests", item.selected.epoch)
  await mkdir(folder, { recursive: true })
  const ref = await publish(path.join(folder, item.selected.request + "-terminal.json"), terminal)
  const file = path.join(value.root, "failed-observation.json")
  const witness = {
    format: "raya.memory.failed-search.observation",
    version: 1,
    observed: Date.now() / 1000,
    entry_sha256: fingerprint(value.running),
    debt,
    original: value.running.launch.receipt,
    terminal,
    terminal_file: { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 },
    authenticated_original_http: true,
    settlement_authority: false,
    qualification: "Synthetic explicit operator input; no genuine HTTP trust claim",
  }
  await writeFile(file, JSON.stringify(witness))
  const data = JSON.parse(await readFile(value.file, "utf8"))
  data["raya.secondBrain.setup"] = value.running
  data["raya.secondBrain.control.uncertainty"] = debt
  await writeFile(value.file, JSON.stringify(data))
  return { file, witness, debt, ref }
}

async function fresh(value: Awaited<ReturnType<typeof fixture>>) {
  const failure = await failed(value)
  await rm(value.closed.path)
  const root = path.join(value.root, "raya-memory-managed-" + crypto.randomUUID().replaceAll("-", ""))
  await mkdir(root)
  await mkdir(path.join(value.root, "System"))
  await copyFile(python, path.join(root, "python.exe"))
  await copyFile(path.resolve("script/memory/supervise.py"), path.join(root, "supervise.py"))
  const ref = async (file: string, limit = 16777216) => {
    const held = await image(file, limit)
    return { path: file, bytes: held.raw.length, sha256: held.digest }
  }
  const cfg = structuredClone(value.cfg)
  const old = path.join(value.root, "old-plan.json")
  await writeFile(old, JSON.stringify({ env: { RAYA_RETRIEVAL_PORT: "58742" } }))
  value.running.managed.plan = await ref(old)
  failure.witness.entry_sha256 = fingerprint(value.running)
  await writeFile(failure.file, JSON.stringify(failure.witness))
  const saved = JSON.parse(await readFile(value.file, "utf8"))
  saved["raya.secondBrain.setup"] = value.running
  await writeFile(value.file, JSON.stringify(saved))
  cfg.root = root
  cfg.python = await ref(path.join(root, "python.exe"), 536870912)
  cfg.supervisor = await ref(path.join(root, "supervise.py"))
  for (const kind of ["memory", "retrieval"] as const) {
    const space = cfg.namespaces[kind]
    space.root = path.join(root, kind)
    await mkdir(path.join(space.root, "Runs"), { recursive: true })
    await mkdir(path.join(space.root, "Requests"))
  }
  cfg.notes = {
    root: value.root,
    system: path.join(value.root, "System"),
    generations: { root: ["1", "2", "3"], system: ["4", "5", "6"] },
  }
  const text = (generations: Record<string, readonly string[]>) =>
    "{" +
    Object.entries(generations)
      .map(([key, row]) => JSON.stringify(key) + ":[" + row.join(",") + "]")
      .join(",") +
    "}"
  const namespace = (kind: "memory" | "retrieval", prefix: string) => ({
    [prefix + "_ROOT"]: cfg.namespaces[kind].root,
    [prefix + "_SID"]: cfg.namespaces[kind].sid,
    [prefix + "_GENERATIONS"]: text(cfg.namespaces[kind].generations),
  })
  const selection = namespace("retrieval", "RAYA_RETRIEVAL_RECEIPT")
  const files = [
    ...Object.entries(release).map(([name, sha256]) => ({ path: path.join(root, "source", "memory", name), sha256 })),
    ...Object.entries(images).map(([name, sha256]) => ({ path: path.join(root, "source", name), sha256 })),
  ]
  const common = {
    format: "raya.memory.managed.supervisor",
    version: 1,
    execution_admitted: true,
    root,
    python_sha256: interpreter,
    files,
    directories: [],
  }
  const memory = {
    ...common,
    kind: "memory",
    source: path.join(root, "source", "memory"),
    source_sha256: release,
    port: 58743,
    notes_selection: cfg.notes,
    retrieval_selection: selection,
    env: {
      ...namespace("memory", "RAYA_MEMORY_OPERATION"),
      RAYA_MEMORY_ROOT: value.root,
      RAYA_MEMORY_PORT: "58743",
      RAYA_RETRIEVAL_PORT: "58744",
      RAYA_MEMORY_NOTE_GENERATIONS: text(cfg.notes.generations),
      RAYA_MEMORY_TOKEN_FILE: path.join(root, "tokens", "memory.token"),
      RAYA_MEMORY_RETRIEVAL_TOKEN_FILE: path.join(root, "tokens", "retrieval.token"),
      RAYA_MEMORY_RETRIEVAL_PROTOCOL: "raya.retrieval.request.settlement.v2",
      RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256: reusable,
    },
  }
  const retrieval = {
    ...common,
    kind: "retrieval",
    source: path.join(root, "source"),
    source_sha256: images,
    port: 58744,
    retrieval_protocol: "raya.retrieval.request.settlement.v2",
    env: {
      ...selection,
      RAYA_RETRIEVAL_PORT: "58744",
      RAYA_RETRIEVAL_TOKEN_FILE: path.join(root, "tokens", "retrieval.token"),
      RAYA_RETRIEVAL_RELEASE_SHA256: reusable,
    },
  }
  await writeFile(path.join(root, "memory.json"), JSON.stringify(memory))
  await writeFile(path.join(root, "retrieval.json"), JSON.stringify(retrieval))
  cfg.plan = await ref(path.join(root, "memory.json"))
  cfg.retrieval = await ref(path.join(root, "retrieval.json"))
  const witness = await image(failure.file)
  const input = {
    format: "raya.memory.failed-search.fresh-start",
    version: 1,
    observation: { path: failure.file, bytes: witness.raw.length, sha256: witness.digest, tuple: witness.tuple },
    setup: { ...value.setup, origin: "http://127.0.0.1:58743" },
    managed: cfg,
  }
  const file = path.join(root, "fresh-start.json")
  await writeFile(file, JSON.stringify(input))
  return { ...failure, file, input }
}

test("missing producer closure quarantines the exact prior pair without claiming request settlement", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await fresh(value)
    selected.input.format = "raya.memory.unclosed-pair.fresh-start"
    selected.input.observation = value.running.launch.receipt
    await writeFile(selected.file, JSON.stringify(selected.input))
    const host = value.settings()
    await expect(host.archive(selected.file, async () => true)).rejects.toThrow("Unsettled request debt")
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    delete saved["raya.secondBrain.control.uncertainty"]
    await writeFile(value.file, JSON.stringify(saved))
    const before = await readFile(value.file)
    const original = await readFile(value.running.launch.receipt.path)
    await host.archive(selected.file, async () => false)
    expect(await readFile(value.file)).toEqual(before)
    await writeFile(value.closed.path, "damaged closure remains evidence")
    await expect(host.archive(selected.file, async () => true)).rejects.toThrow("Existing closure")
    expect(await readFile(value.file)).toEqual(before)
    await rm(value.closed.path)
    await host.archive(selected.file, async (review) => {
      expect(review.outcome).toBe("unknown")
      expect(review.closure).toBe("unproven")
      expect(review.settlement).toBe(false)
      return true
    })
    const current = JSON.parse(await readFile(value.file, "utf8"))
    const audit = current[`raya.secondBrain.failedSearchArchive.${value.running.launch.receipt.sha256}`]
    expect(audit.previous).toEqual(value.running)
    expect(audit.phase).toBe("applied")
    expect(audit.debt).toBeUndefined()
    expect(audit.settlement).toBe(false)
    expect(current["raya.secondBrain.quarantinedSetups"]).toEqual([value.running])
    expect(await readFile(value.running.launch.receipt.path)).toEqual(original)
    expect(host.pending()).toBeUndefined()
    expect((await host.load())!.setup).toEqual(selected.input.setup)
    await expect(host.save(value.setup, "synthetic", value.cfg)).rejects.toThrow("Quarantined Memory address")
  } finally {
    await value.cleanup()
  }
}, 60000)

test("fresh-start quarantine retains unproven failure and admits a separate setup without a closure receipt", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await fresh(value)
    const host = value.settings()
    await host.archive(selected.file, async (review) => {
      expect(review.closure).toBe("unproven")
      expect(review.settlement).toBe(false)
      return true
    })
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    const audit = saved[`raya.secondBrain.failedSearchArchive.${selected.debt.request.id}`]
    expect(audit.phase).toBe("applied")
    expect(audit.closure).toBe("unproven")
    expect(audit.settlement).toBe(false)
    expect(audit.previous).toEqual(value.running)
    expect(audit.debt).toEqual(selected.debt)
    expect(audit.absence.helper.originalJoined).toBe(true)
    expect(host.pending()).toBeUndefined()
    const loaded = await host.load()
    expect(loaded!.key).toBe("synthetic")
    expect(loaded!.setup).toEqual(selected.input.setup)
    expect(loaded!.launch!.predecessor).toBeUndefined()
    expect(saved["raya.secondBrain.setup"].launch).toBeUndefined()
    await expect(host.save(value.setup, "synthetic", value.cfg)).rejects.toThrow("Quarantined Memory address")
    await host.clear()
    await host.save(selected.input.setup, "synthetic", selected.input.managed)
    expect((await host.load())!.key).toBe("synthetic")
    expect(saved["raya.secondBrain.quarantinedSetups"]).toEqual([value.running])
  } finally {
    await value.cleanup()
  }
}, 60000)

test("fresh-start refuses live listeners and used or historical namespaces, without changing saved debt", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await fresh(value)
    const before = await readFile(value.file)
    const reviewed = await archive(selected.file, value.running, selected.debt)
    const server = Bun.serve({ hostname: "127.0.0.1", port: reviewed.ports[0], fetch: () => new Response("test") })
    try {
      await expect(absent(reviewed)).rejects.toThrow("Memory helper failures")
    } finally {
      await server.stop(true)
    }
    await writeFile(path.join(selected.input.managed.namespaces.memory.root, "Runs", "used.json"), "{}")
    await expect(value.settings().archive(selected.file, async () => true)).rejects.toThrow("Unused fresh")
    await rm(path.join(selected.input.managed.namespaces.memory.root, "Runs", "used.json"))
    selected.input.managed.namespaces.memory.root = value.cfg.namespaces.memory.root
    await writeFile(selected.file, JSON.stringify(selected.input))
    await expect(value.settings().archive(selected.file, async () => true)).rejects.toThrow("Old operation namespace")
    expect(await readFile(value.file)).toEqual(before)
  } finally {
    await value.cleanup()
  }
}, 60000)

test("fresh-start refuses every earlier quarantined namespace and changed reviewed selection", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await fresh(value)
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    const old = structuredClone(value.running)
    old.managed.namespaces.memory.root = selected.input.managed.namespaces.memory.root
    saved["raya.secondBrain.quarantinedSetups"] = [old]
    await writeFile(value.file, JSON.stringify(saved))
    const before = await readFile(value.file)
    await expect(value.settings().archive(selected.file, async () => true)).rejects.toThrow(
      "Quarantined Memory namespace",
    )
    expect(await readFile(value.file)).toEqual(before)
    delete saved["raya.secondBrain.quarantinedSetups"]
    await writeFile(value.file, JSON.stringify(saved))
    const prior = await readFile(value.file)
    await expect(
      value.settings().archive(selected.file, async () => {
        selected.input.setup.origin = "http://127.0.0.1:58745"
        await writeFile(selected.file, JSON.stringify(selected.input))
        return true
      }),
    ).rejects.toThrow()
    expect(await readFile(value.file)).toEqual(prior)
  } finally {
    await value.cleanup()
  }
}, 60000)

test("fresh-start cancellation and failing journal publication preserve old failure for retry", async () => {
  let armed = false
  const error = new Error("Original archive journal failure")
  const value = await fixture("raya.memory.operation.v2", async (key, input) => {
    if (!armed || key !== "raya.secondBrain.control.uncertainty" || input !== undefined) return
    armed = false
    throw error
  })
  try {
    const selected = await fresh(value)
    const before = await readFile(value.file)
    const host = value.settings()
    await host.archive(selected.file, async () => false)
    expect(await readFile(value.file)).toEqual(before)
    armed = true
    await expect(host.archive(selected.file, async () => true)).rejects.toBe(error)
    expect(host.pending()).toEqual(selected.debt)
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    expect(saved["raya.secondBrain.setup"]).toEqual(value.running)
    expect(saved[`raya.secondBrain.failedSearchArchive.${selected.debt.request.id}`].phase).toBe("failed")
    await host.archive(selected.file, async () => true)
    expect(host.pending()).toBeUndefined()
  } finally {
    await value.cleanup()
  }
}, 60000)

test("explicit failed-empty repair preserves failure audit and credential and admits a clean original successor", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await failed(value)
    const before = await readFile(value.file)
    const host = value.settings()
    await expect(host.load()).rejects.toThrow("pending original settlement")
    await host.repair(selected.file, async (review) => {
      expect(await readFile(value.file)).toEqual(before)
      expect(review.outcome).toBe("failed")
      expect(review.request).toBe(selected.debt.request.id)
      return true
    })
    expect(host.pending()).toBeUndefined()
    const cfg = await host.load()
    expect(cfg!.key).toBe("synthetic")
    expect(cfg!.setup).toEqual(value.setup)
    expect(cfg!.launch!.predecessor).toEqual(value.closed)
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    const audit = saved[`raya.secondBrain.failedSearchRecovery.${selected.debt.request.id}`]
    expect(audit.phase).toBe("applied")
    expect(audit.previous).toEqual(value.running)
    expect(audit.debt).toEqual(selected.debt)
    expect(saved["raya.secondBrain.setup"].credential).toBe(value.running.credential)
  } finally {
    await value.cleanup()
  }
})

test("failed-empty repair cancellation and changed reviewed source retain original metadata", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await failed(value)
    const before = await readFile(value.file)
    const host = value.settings()
    await host.repair(selected.file, async () => false)
    expect(await readFile(value.file)).toEqual(before)
    await expect(
      host.repair(selected.file, async () => {
        await writeFile(selected.file, JSON.stringify({ ...selected.witness, observed: selected.witness.observed + 1 }))
        return true
      }),
    ).rejects.toThrow("repair changed")
    expect(await readFile(value.file)).toEqual(before)
    expect(host.pending()).toEqual(selected.debt)
  } finally {
    await value.cleanup()
  }
})

test("failed-empty repair restores failed journal writes and allows the same reviewed retry", async () => {
  let armed = false
  const error = new Error("Original repair journal write failed")
  const value = await fixture("raya.memory.operation.v2", async (key, input) => {
    if (!armed || key !== "raya.secondBrain.control.uncertainty" || input !== undefined) return
    armed = false
    throw error
  })
  try {
    const selected = await failed(value)
    const host = value.settings()
    armed = true
    await expect(host.repair(selected.file, async () => true)).rejects.toBe(error)
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    expect(saved["raya.secondBrain.setup"]).toEqual(value.running)
    expect(host.pending()).toEqual(selected.debt)
    expect(saved[`raya.secondBrain.failedSearchRecovery.${selected.debt.request.id}`].phase).toBe("failed")
    await host.repair(selected.file, async () => true)
    expect(host.pending()).toBeUndefined()
    expect((await host.load())!.launch!.predecessor).toEqual(value.closed)
  } finally {
    await value.cleanup()
  }
})

test("failed-empty repair refuses a substituted current setup without overwriting it", async () => {
  const value = await fixture("raya.memory.operation.v2")
  try {
    const selected = await failed(value)
    const host = value.settings()
    const replacement = { ...value.running, setup: { ...value.running.setup, root: "C:\\ForeignNotes" } }
    await expect(
      host.repair(selected.file, async () => {
        const saved = JSON.parse(await readFile(value.file, "utf8"))
        saved["raya.secondBrain.setup"] = replacement
        await writeFile(value.file, JSON.stringify(saved))
        return true
      }),
    ).rejects.toThrow("repair changed")
    const saved = JSON.parse(await readFile(value.file, "utf8"))
    expect(saved["raya.secondBrain.setup"]).toEqual(replacement)
    expect(host.pending()).toEqual(selected.debt)
    expect(saved[`raya.secondBrain.failedSearchRecovery.${selected.debt.request.id}`]).toBeUndefined()
  } finally {
    await value.cleanup()
  }
})

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
