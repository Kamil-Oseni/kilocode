import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Pair } from "../../src/second-brain/managed/pair"
import { ManagedOwner, Pipes, publish } from "../../src/second-brain/managed/owner"
import { descriptor, paired } from "../../src/second-brain/managed/descriptor"
import { interpreter, supervisor, retrieval } from "../../src/second-brain/managed/catalog"
import { release } from "../../src/second-brain/control/catalog-v2"
import { images, catalogs, fingerprint, readiness } from "../../src/second-brain/managed/reuse-catalog"
import { document, canonical, sha } from "../../src/second-brain/control/frames"
import { protect } from "../../src/second-brain/control/protection"
import { observe } from "../../src/second-brain/control/identity"
import { packaged } from "../../src/second-brain/control/index"
import { BrainService } from "../../src/second-brain/service"
import { project, generation } from "../../src/second-brain/managed/generation"
import { command } from "../../src/second-brain/control/command"
import { BrainSettings } from "../../src/second-brain/settings"
import ts from "typescript"

const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
const script = path.resolve("script/memory/supervise.py")
// Actual supervisor gate functions execute in nonmodel original children.
const body = `import ast,sys,json,time,threading,pathlib
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
names={'reject','emit','phase','gate'}
PHASE=threading.Lock();BEGUN=time.monotonic()
exec(compile(ast.fix_missing_locations(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[])),sys.argv[1],'exec'))
if gate():
 pathlib.Path(sys.argv[2]).write_text('nonmodel body admitted')
 phase('uvicorn-started')
 if sys.argv[6]=='broken':
  import os;os.close(0);time.sleep(.4)
 else:sys.stdin.buffer.readline(8)
 emit({'format':'raya.memory.disposable.supervisor.closed','passed':True,'control_joined':True,'errors':[]})
 with pathlib.Path(sys.argv[3]).open('a',newline='') as file:file.write(sys.argv[4]+'\\n')
 sys.exit(int(sys.argv[5]))
`
function selected(root: string) {
  const ref = (name: string, sha256: string) => ({ path: path.join(root, name), bytes: 1, sha256 })
  const space = (kind: string) => ({
    root: path.join(root, kind),
    sid: "S-1-5-21-1-2-3-1001",
    generations: { root: ["18446744073709551615", "2", "3"], Runs: ["4", "5", "6"], Requests: ["7", "8", "9"] },
  })
  return descriptor({
    format: "raya.memory.managed.launch",
    version: 2,
    root,
    python: ref("python.exe", interpreter),
    supervisor: ref("supervise.py", supervisor),
    plan: ref("memory.json", "a".repeat(64)),
    retrieval: ref("retrieval.json", "b".repeat(64)),
    namespaces: { memory: space("memory"), retrieval: space("retrieval") },
  })
}
function plans(root: string) {
  const cfg = selected(root)
  const namespace = {
    RAYA_RETRIEVAL_RECEIPT_ROOT: cfg.namespaces.retrieval.root,
    RAYA_RETRIEVAL_RECEIPT_SID: cfg.namespaces.retrieval.sid,
    RAYA_RETRIEVAL_RECEIPT_GENERATIONS: JSON.stringify(cfg.namespaces.retrieval.generations),
  }
  const files = [
    ...Object.entries(release).map(([name, sha256]) => ({ path: path.join(root, "source", "memory", name), sha256 })),
    ...Object.entries(retrieval).map(([name, sha256]) => ({
      path: path.join(root, "source", "retrieval", name),
      sha256,
    })),
  ]
  const memory = {
    files,
    directories: [],
    kind: "memory",
    source: path.join(root, "source/memory"),
    source_sha256: release,
    port: 58741,
    retrieval_selection: namespace,
    env: {
      RAYA_RETRIEVAL_PORT: "58742",
      RAYA_MEMORY_TOKEN_FILE: path.join(root, "tokens/memory.token"),
      RAYA_MEMORY_RETRIEVAL_TOKEN_FILE: path.join(root, "tokens/retrieval.token"),
    },
  }
  const plan = {
    format: "raya.memory.managed.supervisor",
    version: 1,
    root,
    kind: "retrieval",
    execution_admitted: true,
    python_sha256: interpreter,
    files,
    directories: [],
    source: path.join(root, "source/retrieval"),
    source_sha256: retrieval,
    port: 58742,
    env: {
      ...namespace,
      RAYA_RETRIEVAL_PORT: "58742",
      RAYA_RETRIEVAL_TOKEN_FILE: path.join(root, "tokens/retrieval.token"),
    },
  }
  return { cfg, memory, plan }
}
test("paired descriptor requires explicit Retrieval ref and exact selected release/ports/token/assets", () => {
  const value = plans("C:\\Synthetic\\raya-memory-managed-pair")
  paired(value.cfg, value.memory, value.plan)
  for (const protocol of [null, undefined, true, 1, "", {}, []]) {
    expect(() => paired(value.cfg, value.memory, { ...value.plan, retrieval_protocol: protocol })).toThrow()
    expect(() =>
      paired(
        value.cfg,
        { ...value.memory, env: { ...value.memory.env, RAYA_MEMORY_RETRIEVAL_PROTOCOL: protocol } },
        value.plan,
      ),
    ).toThrow()
  }
  expect(() => descriptor({ ...value.cfg, retrieval: undefined })).toThrow()
  for (const field of ["source_sha256", "port", "files", "env"] as const) {
    const changed = { ...value.plan, [field]: field === "port" ? 58741 : {} }
    expect(() => paired(value.cfg, value.memory, changed)).toThrow()
  }
  const single = { ...value.cfg, version: 1 }
  delete single.retrieval
  expect(descriptor(single).version).toBe(1)
  expect(() => paired(descriptor(single), value.memory, value.plan)).toThrow()
})
test("reusable selection binds exact source closure, protocol and independent release", () => {
  const value = plans("C:\\Synthetic\\raya-memory-managed-reuse")
  const files = [
    ...value.memory.files.filter((item) => item.path.includes("memory" + path.sep)),
    ...Object.entries(images).map(([name, sha256]) => ({ path: path.join(value.cfg.root, "source", name), sha256 })),
  ]
  const memory = {
    ...value.memory,
    files,
    env: {
      ...value.memory.env,
      RAYA_MEMORY_RETRIEVAL_PROTOCOL: "raya.retrieval.request.settlement.v2",
      RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256: fingerprint,
    },
  }
  const plan = {
    ...value.plan,
    files,
    retrieval_protocol: "raya.retrieval.request.settlement.v2",
    source: path.join(value.cfg.root, "source"),
    source_sha256: images,
    env: { ...value.plan.env, RAYA_RETRIEVAL_RELEASE_SHA256: fingerprint },
  }
  paired(value.cfg, memory, plan)
  for (const change of [
    { retrieval_protocol: "unknown" },
    { retrieval_protocol: "raya.retrieval.retirement.v1" },
    { source: value.plan.source },
    { source_sha256: retrieval },
    { env: { ...plan.env, RAYA_RETRIEVAL_RELEASE_SHA256: "a".repeat(64) } },
  ])
    expect(() => paired(value.cfg, memory, { ...plan, ...change })).toThrow()
  expect(() => paired(value.cfg, value.memory, plan)).toThrow()
  expect(() =>
    paired(
      value.cfg,
      { ...memory, env: { ...memory.env, RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256: "b".repeat(64) } },
      plan,
    ),
  ).toThrow()
  const missing = files.filter((item) => item.path !== path.join(plan.source, "retrieval_reuse/entry.py"))
  expect(() => paired(value.cfg, { ...memory, files: missing }, { ...plan, files: missing })).toThrow()
})

test("reusable pins match source bytes and readiness cannot adopt a different release", async () => {
  for (const [name, digest] of Object.entries(images))
    expect(sha(await readFile(path.join("script/memory", name)))).toBe(digest)
  const parsed = document(Buffer.from(JSON.stringify({ source_sha256: images, catalog_sha256: catalogs })))
  expect(sha(canonical(parsed.tree, parsed.text))).toBe(fingerprint)
  const health = {
    ownership_protocol: "raya.retrieval.request.settlement.v2",
    selected_release_sha256: fingerprint,
    catalog_sha256: catalogs,
    retirement_unconfirmed: false,
    draining: false,
  }
  readiness(health, fingerprint)
  for (const change of [
    { ownership_protocol: "raya.retrieval.retirement.v1" },
    { selected_release_sha256: "a".repeat(64) },
    { catalog_sha256: {} },
    { retirement_unconfirmed: true },
    { draining: true },
  ])
    expect(() => readiness({ ...health, ...change }, fingerprint)).toThrow()
  expect(() => readiness(health, "b".repeat(64))).toThrow()
})

async function fixture(reserved = true) {
  const root = await mkdtemp(path.join(tmpdir(), "raya-memory-control-paired-"))
  await protect(root)
  await mkdir(path.join(root, "memory", "Runs"), { recursive: true })
  const file = path.join(root, "settings.json")
  await writeFile(file, "{}")
  const secrets = path.join(root, "synthetic-secret.json")
  await writeFile(secrets, "{}")
  const hold: { gate?: Promise<void>; reads: number } = { reads: 0 }
  const settings = new BrainSettings(
    {
      get<T>(name: string) {
        return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
      },
      async update(name: string, value: unknown) {
        const data = JSON.parse(await readFile(file, "utf8"))
        data[name] = value
        await writeFile(file, JSON.stringify(data))
      },
    },
    {
      async get(name) {
        hold.reads++
        await hold.gate
        return JSON.parse(await readFile(secrets, "utf8"))[name]
      },
      async store(name, value) {
        const data = JSON.parse(await readFile(secrets, "utf8"))
        data[name] = value
        await writeFile(secrets, JSON.stringify(data))
      },
      async delete(name) {
        const data = JSON.parse(await readFile(secrets, "utf8"))
        delete data[name]
        await writeFile(secrets, JSON.stringify(data))
      },
    },
  )
  await settings.save(
    {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v1",
      origin: "http://127.0.0.1:58741",
      root: "C:\\Synthetic\\Notes",
      source_sha256: release,
    },
    "synthetic",
    selected(root),
  )
  const cfg = await settings.load()
  const record = settings.managed(cfg!.setup)
  const selection = await publish(path.join(root, "selection.json"), { version: 2, descriptor: selected(root) })
  if (reserved) await record("selected", selection)
  const pair = new Pair()
  const helper = await packaged(path.resolve("."))
  const originals: Record<string, unknown> = {}
  const held: Record<string, Pipes> = {}
  async function open(kind: "memory" | "retrieval", code = 0, broken = false) {
    const child = spawn(
      python,
      [
        "-I",
        "-S",
        "-B",
        "-u",
        "-c",
        body,
        script,
        path.join(root, kind + "-body"),
        path.join(root, "closures"),
        kind,
        String(code),
        broken ? "broken" : "normal",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
    )
    const pipes = new Pipes(child)
    held[kind] = pipes
    pair.hold(kind, pipes)
    await pipes.ready("launch-selected")
    expect(await Bun.file(path.join(root, kind + "-body")).exists()).toBe(false)
    const identity = await observe(child, python, helper.helper, interpreter)
    originals[kind] = await publish(path.join(root, kind + "-original.json"), { selection, identity })
    await pipes.start()
    await pipes.ready("uvicorn-started")
  }
  return {
    root,
    settings,
    record,
    selection,
    pair,
    open,
    originals,
    held,
    hold,
    async commit() {
      expect(held.memory?.running()).toBe(true)
      expect(held.retrieval?.running()).toBe(true)
      const original = await publish(path.join(root, "original.json"), { originals })
      await record("running", original)
    },
    async cleanup() {
      await pair.close("eof").catch((err: unknown) => expect(err).toBeInstanceOf(Error))
      await rm(root, { recursive: true, force: true })
    },
  }
}
test("two original nonmodel children retain fsynced selection, exact native identities, reverse joins and file-backed phase CAS", async () => {
  const value = await fixture()
  try {
    await value.pair.start(async (kind) => value.open(kind), value.commit)
    expect(value.pair.valid()).toBe(true)
    await expect(value.pair.start(async (kind) => value.open(kind), value.commit)).rejects.toThrow("replayed")
    const closures = await value.pair.close()
    expect(closures).toMatchObject({
      memory: { originalJoined: true, readersJoined: true, producerRetirement: true, forced: false },
      retrieval: { originalJoined: true, readersJoined: true, producerRetirement: true, forced: false },
    })
    expect(await readFile(path.join(value.root, "closures"), "utf8")).toBe("memory\nretrieval\n")
    const closed = await publish(path.join(value.root, "closed.json"), { closures })
    await value.record("closed", closed)
    await expect(value.settings.load()).rejects.toThrow()
    expect(value.pair.valid()).toBe(false)
  } finally {
    await value.cleanup()
  }
}, 30000)
test("first original nonzero closure still drains second original and durable uncertainty stays sticky", async () => {
  const value = await fixture()
  try {
    await value.pair.start(async (kind) => value.open(kind, kind === "memory" ? 1 : 0), value.commit)
    await expect(value.pair.close()).rejects.toThrow("uncertain")
    expect(await readFile(path.join(value.root, "closures"), "utf8")).toBe("memory\nretrieval\n")
    expect(await value.held.retrieval.close()).toMatchObject({
      originalJoined: true,
      readersJoined: true,
      producerRetirement: true,
    })
    await value.record("uncertain", value.selection)
    await expect(value.settings.load()).rejects.toThrow("retained")
  } finally {
    await value.cleanup()
  }
}, 30000)
test("held Retrieval callback failure cleans the original and never publishes running, admits Memory or replays", async () => {
  const value = await fixture()
  try {
    await expect(
      value.pair.start(async (kind) => {
        await value.open(kind)
        await expect(value.settings.load()).rejects.toThrow("retained")
        throw new Error("synthetic readiness canceled")
      }, value.commit),
    ).rejects.toThrow("canceled")
    expect(await Bun.file(path.join(value.root, "original.json")).exists()).toBe(false)
    await value.record("uncertain", value.selection)
    const closures = await value.pair.close("eof")
    expect(closures).toMatchObject({
      retrieval: { originalJoined: true, readersJoined: true, producerRetirement: true },
    })
    expect(value.held.memory).toBeUndefined()
    await expect(value.pair.start(async (kind) => value.open(kind), value.commit)).rejects.toThrow("replayed")
  } finally {
    await value.cleanup()
  }
}, 30000)

test("actual broken first child stdin still observes original exit/readers and drains second child", async () => {
  const value = await fixture()
  try {
    await value.pair.start(async (kind) => value.open(kind, 0, kind === "memory"), value.commit)
    await expect(value.pair.close()).rejects.toThrow("uncertain")
    expect(value.held.memory.child.exitCode).toBe(0)
    expect(value.held.memory.eof).toEqual({ stdout: true, stderr: true })
    expect(await value.held.retrieval.close()).toMatchObject({
      originalJoined: true,
      readersJoined: true,
      producerRetirement: true,
    })
  } finally {
    await value.cleanup()
  }
}, 30000)

test("actual BrainService concurrent preparation shares the original promise and retains failed managed preflight", async () => {
  const value = await fixture(false)
  const service = new BrainService(value.settings, path.resolve("."))
  const prepare = Reflect.get(service, "prepare") as (signal?: AbortSignal) => Promise<unknown>
  let release!: () => void
  value.hold.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const before = value.hold.reads
  const first = prepare.call(service)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = prepare.call(service)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(value.hold.reads).toBe(before + 1)
  const states = Promise.allSettled([first, second])
  release()
  try {
    const result = await states
    expect(result.every((row) => row.status === "rejected")).toBe(true)
    const errors = result.map((row) => (row.status === "rejected" ? row.reason : undefined))
    expect(errors[0]).toBe(errors[1])
    const reads = value.hold.reads
    await expect(prepare.call(service)).rejects.toThrow()
    expect(value.hold.reads).toBe(reads)
    const stored = await readFile(path.join(value.root, "settings.json"))
    await service.dispose()
    await service.dispose()
    expect(await readFile(path.join(value.root, "settings.json"))).toEqual(stored)
    expect(await Bun.file(path.join(value.root, "managed-closed.json")).exists()).toBe(false)
  } finally {
    await service.dispose()
    await value.cleanup()
  }
}, 30000)

test("actual ManagedOwner wiring publishes running through the post-readiness commit only", async () => {
  const source = await readFile(path.resolve("src/second-brain/managed/owner.ts"), "utf8")
  const tree = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "pair.start") calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  expect(calls.length).toBe(1)
  expect(calls[0].arguments.length).toBe(2)
  const running = (node: ts.Node): number => {
    const matches: ts.Node[] = []
    const scan = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(tree) === "this.record" &&
        node.arguments[0]?.getText(tree) === '"running"'
      )
        matches.push(node)
      ts.forEachChild(node, scan)
    }
    scan(node)
    return matches.length
  }
  expect(running(calls[0].arguments[0])).toBe(0)
  expect(running(calls[0].arguments[1])).toBe(1)
})

test("both live originals with failed Memory readiness never commit running and both drain", async () => {
  const value = await fixture()
  try {
    await expect(
      value.pair.start(async (kind) => {
        await value.open(kind)
        if (kind === "memory") throw new Error("synthetic Memory readiness failure")
      }, value.commit),
    ).rejects.toThrow("readiness failure")
    await expect(value.settings.load()).rejects.toThrow("retained")
    expect(await Bun.file(path.join(value.root, "original.json")).exists()).toBe(false)
    await value.record("uncertain", value.selection)
    const closures = await value.pair.close("eof")
    expect(closures).toMatchObject({
      memory: { originalJoined: true, readersJoined: true },
      retrieval: { originalJoined: true, readersJoined: true },
    })
  } finally {
    await value.cleanup()
  }
}, 30000)

// Fixture-seeded retained ownership isolates the real per-call guard; it does not claim ManagedOwner.open admission.
test("actual service refuses a cached successful preparation after a retained original exits", async () => {
  const value = await fixture()
  try {
    await value.pair.start(async (kind) => value.open(kind), value.commit)
    const cfg = await value.settings.load()
    if (!cfg?.managed) throw new Error("Missing fixture descriptor")
    const owner = new ManagedOwner(cfg.managed, cfg.setup, path.resolve("."), value.record)
    Reflect.set(owner, "pair", value.pair)
    Reflect.set(owner, "admitted", true)
    const service = new BrainService(value.settings, path.resolve("."))
    Reflect.set(service, "managed", owner)
    Reflect.set(service, "opening", Promise.resolve())
    const prepare = Reflect.get(service, "prepare") as () => Promise<unknown>
    expect(await prepare.call(service)).toMatchObject({ setup: cfg.setup })
    const original = value.held.memory
    expect(await original.close()).toMatchObject({ originalJoined: true, readersJoined: true })
    expect(owner.valid()).toBe(false)
    expect(await value.settings.load()).toMatchObject({ setup: cfg.setup })
    await expect(prepare.call(service)).rejects.toThrow("Original managed generation is unavailable")
    await expect(prepare.call(service)).rejects.toThrow("Original managed generation is unavailable")
    expect(value.held.memory).toBe(original)
    expect(value.held.retrieval.running()).toBe(true)
  } finally {
    await value.cleanup()
  }
}, 30000)

test("namespace plan projection preserves unmodified unsafe uint64 tokens and paired catalog selection", () => {
  const value = plans("C:\\Synthetic\\raya-memory-managed-pair")
  const namespaces = {
    memory: { ...value.cfg.namespaces.memory, root: path.join(value.cfg.root, "fresh", "memory") },
    retrieval: { ...value.cfg.namespaces.retrieval, root: path.join(value.cfg.root, "fresh", "retrieval") },
  }
  const raw = Buffer.from(
    JSON.stringify(value.memory).replace(
      '"directories":[]',
      '"directories":[{"path":"retained","identity":[18446744073709551615,2,3]}]',
    ),
  )
  const next = project(raw, "memory", namespaces, '[{"path":"retained","identity":[18446744073709551615,2,3]}]')
  expect(next.toString()).toContain('"identity":[18446744073709551615,2,3]')
  const plan = JSON.parse(next.toString())
  expect(plan.files).toEqual(value.memory.files)
  expect(plan.source_sha256).toEqual(value.memory.source_sha256)
  expect(plan.env.RAYA_MEMORY_OPERATION_GENERATIONS).toContain("18446744073709551615")
  const retrieval = JSON.parse(
    project(
      Buffer.from(JSON.stringify(value.plan)),
      "retrieval",
      namespaces,
      JSON.stringify(plan.directories),
    ).toString(),
  )
  paired(descriptor({ ...value.cfg, namespaces }), plan, retrieval)
})

test("fresh generation creates protected original namespaces accepted by real Python validator and refuses collision", async () => {
  const value = await fixture(false)
  try {
    const sid = (
      await command(
        path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
        { windowsHide: true },
      )
    ).stdout.trim()
    const planset = plans(value.root)
    const cfg = descriptor({
      ...planset.cfg,
      namespaces: {
        memory: { ...planset.cfg.namespaces.memory, sid },
        retrieval: { ...planset.cfg.namespaces.retrieval, sid },
      },
    })
    await mkdir(path.join(value.root, "source", "memory"), { recursive: true })
    await copyFile(
      path.resolve("script/memory/service/namespace.py"),
      path.join(value.root, "source", "memory", "namespace.py"),
    )
    const observed = descriptor({ ...cfg, python: { ...cfg.python, path: python } })
    const launch = { root: path.join(value.root, "memory", "Runs", "a".repeat(32)) }
    const files = [
      { raw: Buffer.alloc(0) },
      { raw: Buffer.alloc(0) },
      { raw: Buffer.from(JSON.stringify(planset.memory)) },
      { raw: Buffer.from(JSON.stringify(planset.plan)) },
    ]
    const next = await generation(observed, launch, files)
    const witness = path.join(value.root, "fresh-witness.json")
    await publish(witness, next.namespaces)
    const script =
      "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('selected_namespace',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); rows=json.load(open(sys.argv[2])); [m.Namespace(v['root'],v['sid'],{k:[int(x) for x in t] for k,t in v['generations'].items()}) for v in rows.values()]; print('verified-two-namespaces')"
    const result = await command(
      python,
      ["-I", "-S", "-B", "-c", script, path.resolve("script/memory/service/namespace.py"), witness],
      { windowsHide: true },
    )
    expect(result.stdout.trim()).toBe("verified-two-namespaces")
    expect(next.plan.path).toBe(path.join(launch.root, "memory-plan.json"))
    await expect(generation(observed, launch, files)).rejects.toThrow()
    const memory = JSON.parse(await readFile(next.plan.path, "utf8"))
    const retrieval = JSON.parse(await readFile(next.retrieval!.path, "utf8"))
    expect(memory.directories.length).toBe(7)
    expect(memory.directories).toEqual(retrieval.directories)
    expect(next.python.path).toBe(python)
    expect(memory.files).toEqual(retrieval.files)
    const failed = { root: path.join(value.root, "memory", "Runs", "b".repeat(32)) }
    await writeFile(path.join(value.root, "source", "memory", "namespace.py"), "# changed private fixture")
    await expect(generation(observed, failed, files)).rejects.toThrow("Reviewed namespace observer required")
    await expect(generation(observed, failed, files)).rejects.toThrow()
    expect(await Bun.file(path.join(failed.root, "memory-plan.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(failed.root, "retrieval-plan.json")).exists()).toBe(false)
  } finally {
    await value.cleanup()
  }
}, 30000)
