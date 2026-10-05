import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Pipes, publish, ManagedOwner } from "../../src/second-brain/managed/owner"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { interpreter, supervisor } from "../../src/second-brain/managed/catalog"
import { protect } from "../../src/second-brain/control/protection"
import { BrainSettings } from "../../src/second-brain/settings"
import { sources } from "../../src/second-brain/setup-v2"
import { sha } from "../../src/second-brain/control/frames"
import { observe } from "../../src/second-brain/control/identity"
import { packaged } from "../../src/second-brain/control/index"
import { parseCatalog } from "../../src/second-brain/control/catalog"
import { release, bridge } from "../../src/second-brain/control/catalog-v2"
import { metadata } from "../../src/second-brain/manifest"
import { BrainService } from "../../src/second-brain/service"
import { BrainControl } from "../../src/second-brain/control"
import { Failure } from "../../src/second-brain/client"
import ts from "typescript"

const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
const source = path.resolve("script/memory/supervise.py")
// Execute the actual source AST gate, never import the supervisor or its service/model body.
const fixture = `import ast,sys,json,time,threading,pathlib
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
names={'reject','emit','phase','gate'}
code=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
PHASE=threading.Lock()
BEGUN=time.monotonic()
exec(compile(ast.fix_missing_locations(code),sys.argv[1],'exec'))
if gate():
 pathlib.Path(sys.argv[2]).write_text('synthetic body admitted',encoding='utf-8')
 phase('uvicorn-started')
 print('synthetic stderr',file=sys.stderr,flush=True)
 raw=sys.stdin.buffer.readline(8)
 if raw not in (b'',b'STOP\\n',b'STOP\\r\\n'): reject('Literal stop required')
 emit({'format':'raya.memory.disposable.supervisor.closed','passed':True,'control_joined':True,'errors':[]})
`

async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-memory-control-managed-"))
  await protect(dir)
  return dir
}
function child(dir: string) {
  return new Pipes(
    spawn(python, ["-I", "-S", "-B", "-u", "-c", fixture, source, path.join(dir, "body")], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }),
  )
}

test("reviewed supervisor and interpreter are fixed, namespace generations are immutable lossless strings", async () => {
  expect(sha(await readFile(source))).toBe(supervisor)
  expect(sha(await readFile(python))).toBe(interpreter)
  const input = selected()
  const cfg = descriptor(input)
  input.namespaces.memory.generations.root[0] = "1"
  expect(cfg.namespaces.memory.generations.root[0]).toBe("18446744073709551615")
  expect(Object.isFrozen(cfg.namespaces.memory.generations.root)).toBe(true)
  expect(() => descriptor({ ...selected(), python: { ...selected().python, sha256: "a".repeat(64) } })).toThrow()
  const invalid = selected()
  invalid.namespaces.memory.generations.root[0] = "18446744073709551616"
  expect(() => descriptor(invalid)).toThrow()
})

test("create-new fsynced selection precedes the original gate and STOP joins both original streams", async () => {
  const dir = await root()
  const file = path.join(dir, "reservation.json")
  const receipt = await publish(file, { selected: true })
  const held = child(dir)
  try {
    await held.ready("launch-selected")
    expect(await Bun.file(path.join(dir, "body")).exists()).toBe(false)
    expect(sha(await readFile(file))).toBe(receipt.sha256)
    await expect(publish(file, { replaced: true })).rejects.toThrow()
    const helper = await packaged(path.resolve("."))
    const identity = await observe(held.child, python, helper.helper, interpreter)
    expect(identity.pid).toBe(held.child.pid!)
    expect(identity.parent).toBe(process.pid)
    expect(identity.birth).toMatch(/^\d+$/)
    const original = await publish(path.join(dir, "original.json"), { selected: receipt, identity })
    expect(sha(await readFile(original.path))).toBe(original.sha256)
    expect(await Bun.file(path.join(dir, "body")).exists()).toBe(false)
    await held.start()
    await held.ready("uvicorn-started")
    expect(await readFile(path.join(dir, "body"), "utf8")).toBe("synthetic body admitted")
    const ending = held.close()
    expect(held.close()).toBe(ending)
    expect(await ending).toMatchObject({
      code: 0,
      originalJoined: true,
      readersJoined: true,
      eof: { stdout: true, stderr: true },
      producerRetirement: true,
      nativeFamilyRetirement: false,
      coldSettlementAuthority: false,
    })
    expect(sha(await readFile(file))).toBe(receipt.sha256)
  } finally {
    await held.close("eof").catch((err: unknown) => expect(err).toBeInstanceOf(Error))
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

for (const mode of ["eof", "stop"] as const) {
  test(`original ${mode} before START never admits the body and preserves its reservation`, async () => {
    const dir = await root()
    const receipt = await publish(path.join(dir, "reservation.json"), { selected: true })
    const held = child(dir)
    try {
      await held.ready("launch-selected")
      expect(await held.close(mode)).toMatchObject({
        code: 0,
        readersJoined: true,
        producerRetirement: false,
        preStartRetirement: true,
      })
      expect(await Bun.file(path.join(dir, "body")).exists()).toBe(false)
      expect(sha(await readFile(receipt.path))).toBe(receipt.sha256)
    } finally {
      await held.close("eof").catch((err: unknown) => expect(err).toBeInstanceOf(Error))
      await rm(dir, { recursive: true, force: true })
    }
  }, 30000)
}

test("expired gate observations retain the original child and join it through EOF", async () => {
  const dir = await root()
  const held = child(dir)
  try {
    await held.ready("launch-selected")
    await expect(held.ready("uvicorn-started", 20)).rejects.toThrow("retained")
    expect(held.child.exitCode).toBeNull()
    expect(held.running()).toBe(true)
    expect(await held.close("eof")).toMatchObject({ originalJoined: true, readersJoined: true, forced: false })
    expect(await Bun.file(path.join(dir, "body")).exists()).toBe(false)
  } finally {
    await held.close("eof").catch((err: unknown) => expect(err).toBeInstanceOf(Error))
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test("an original gate refusal stays failed after natural exit and pipe joins", async () => {
  const dir = await root()
  const held = child(dir)
  try {
    await held.ready("launch-selected")
    held.child.stdin!.write("WRONG\n")
    await expect(held.close("eof")).rejects.toThrow("streams")
    expect(held.child.exitCode).toBe(1)
    expect(held.eof).toEqual({ stdout: true, stderr: true })
    expect(await Bun.file(path.join(dir, "body")).exists()).toBe(false)
    await expect(held.start()).rejects.toThrow()
  } finally {
    await held.close("eof").catch((err: unknown) => expect(err).toBeInstanceOf(Error))
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

function selected() {
  const space = () => ({
    root: "C:\\Synthetic\\Namespace",
    sid: "S-1-5-21-1-2-3-1001",
    generations: { root: ["18446744073709551615", "2", "3"], Runs: ["4", "5", "6"], Requests: ["7", "8", "9"] },
  })
  return {
    format: "raya.memory.managed.launch",
    version: 1,
    python: { path: python, bytes: 1, sha256: interpreter },
    supervisor: { path: source, bytes: 1, sha256: supervisor },
    plan: { path: "C:\\Synthetic\\plan.json", bytes: 1, sha256: "b".repeat(64) },
    root: "C:\\Synthetic\\raya-memory-managed-test",
    namespaces: { memory: space(), retrieval: space() },
  }
}

test("file-backed managed phases refuse restarted credential use, replay and foreign loaded setup", async () => {
  const dir = await root()
  const file = path.join(dir, "settings.json")
  await writeFile(file, "{}")
  let reads = 0
  const storage = {
    get<T>(name: string) {
      return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
    },
    async update(name: string, value: unknown) {
      const data = JSON.parse(await readFile(file, "utf8"))
      data[name] = value
      await writeFile(file, JSON.stringify(data))
    },
  }
  const secrets = {
    async get() {
      reads++
      return "synthetic"
    },
    async store() {
      return undefined
    },
    async delete() {
      return undefined
    },
  }
  const setup = {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    origin: "http://127.0.0.1:8874",
    root: "C:\\Synthetic\\Notes",
    source_sha256: Object.fromEntries(sources.map((name) => [name, "a".repeat(64)])),
  }
  try {
    const settings = new BrainSettings(storage, secrets)
    await settings.save(setup, "synthetic", descriptor(selected()))
    const loaded = await settings.load()
    expect(() => settings.managed({ ...loaded!.setup })).toThrow()
    const record = settings.managed(loaded!.setup)
    const receipt = await publish(path.join(dir, "selection.json"), { synthetic: true })
    await record("selected", receipt)
    await expect(record("selected", receipt)).rejects.toThrow("replayed")
    const before = reads
    await expect(new BrainSettings(storage, secrets).load()).rejects.toThrow()
    expect(reads).toBe(before)
    await expect(settings.save(setup, "replacement")).rejects.toThrow("close")
    await record("running", receipt)
    expect(await settings.load()).toBeDefined()
    await record("closed", receipt)
    await expect(new BrainSettings(storage, secrets).load()).rejects.toThrow()
    await settings.clear()
    expect(await settings.load()).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

async function catalog() {
  const source = await readFile(path.resolve("src/second-brain/host.ts"), "utf8")
  const tree = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true)
  const owner = tree.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "BrainHost")
  if (!owner || !ts.isClassDeclaration(owner)) throw new Error("Actual BrainHost class required")
  const method = owner.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(tree) === "catalog")
  if (!method || !ts.isMethodDeclaration(method) || !method.body) throw new Error("Actual catalog method required")
  // Native picker/trust responses are fixture inputs; production method, metadata
  // parser, coordinator, settings CAS and original process lifecycle stay real.
  return new Function(
    "vscode",
    "metadata",
    "parseCatalog",
    "Failure",
    "catalogKey",
    `return async function() ${method.body.getText(tree)}`,
  )
}

test("failed pre-START owner joins its original gate and preserves durable uncertainty", async () => {
  const value = await retained(true)
  try {
    const before = await readFile(value.file)
    await value.owner.close()
    const closure = await value.held.close()
    expect(closure).toMatchObject({
      originalJoined: true,
      readersJoined: true,
      preStartRetirement: true,
      producerRetirement: false,
      nativeFamilyRetirement: false,
      coldSettlementAuthority: false,
    })
    expect(value.owner.valid()).toBe(false)
    expect(await readFile(value.file)).toEqual(before)
    expect(await Bun.file(path.join(value.dir, "managed-closed.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(value.dir, "body")).exists()).toBe(false)
    await expect(value.owner.open()).rejects.toThrow("cannot be replaced")
  } finally {
    await value.held.close("eof").catch((err: unknown) => expect(err).toBeInstanceOf(Error))
    await rm(value.dir, { recursive: true, force: true })
  }
}, 30000)

async function retained(prestart = false) {
  const dir = await root()
  const file = path.join(dir, "settings.json")
  await writeFile(file, "{}")
  const storage = {
    get<T>(name: string) {
      return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
    },
    async update(name: string, value: unknown) {
      const data = JSON.parse(await readFile(file, "utf8"))
      data[name] = value
      await writeFile(file, JSON.stringify(data))
    },
  }
  const settings = new BrainSettings(storage, {
    async get() {
      return "synthetic"
    },
    async store() {
      return undefined
    },
    async delete() {
      return undefined
    },
  })
  const setup = {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    origin: "http://127.0.0.1:8874",
    root: "C:\\Synthetic\\Notes",
    source_sha256: release,
  }
  const cfg = descriptor({ ...selected(), root: dir })
  await settings.save(setup, "synthetic", cfg)
  const loaded = await settings.load()
  const record = settings.managed(loaded!.setup)
  const before = await publish(path.join(dir, "managed-reservation.json"), { synthetic: true })
  await record("selected", before)
  const held = child(dir)
  await held.ready("launch-selected")
  const helper = await packaged(path.resolve("."))
  const identity = await observe(held.child, python, helper.helper, interpreter)
  const original = await publish(path.join(dir, "managed-original.json"), { selected: before, identity })
  await record(prestart ? "uncertain" : "running", prestart ? before : original)
  if (!prestart) {
    await held.start()
    await held.ready("uvicorn-started")
  }
  const owner = new ManagedOwner(cfg, loaded!.setup, path.resolve("."), record)
  // Retain the genuine original synthetic child in the production owner. This
  // does not invoke or substitute managed model startup / namespace admission.
  Reflect.set(owner, "pipes", held)
  Reflect.set(owner, "admitted", !prestart)
  Reflect.set(owner, "failed", prestart)
  Reflect.set(owner, "selected", before)
  Reflect.set(owner, "original", original)
  const service = new BrainService(settings)
  Reflect.set(service, "managed", owner)
  Reflect.set(service, "opening", Promise.resolve())
  const selection = path.join(dir, "catalog.json")
  await writeFile(
    selection,
    JSON.stringify({
      format: "raya.memory.control.catalog",
      version: 2,
      python,
      source: path.resolve("script/memory/service"),
      bridge: path.resolve("script/memory/control.py"),
      python_sha256: interpreter,
      bridge_sha256: bridge,
      source_sha256: release,
    }),
  )
  const control = new BrainControl(service, settings, async () => {
    throw new Error("No control process selected")
  })
  return { dir, file, storage, settings, service, control, owner, held, selection }
}

test("actual BrainHost catalog transaction retains the current managed original; default retirement still joins and fences closed setup", async () => {
  const value = await retained()
  try {
    const method = await catalog()
    const native = {
      window: {
        async showOpenDialog() {
          return [{ scheme: "file", fsPath: value.selection }]
        },
        async showWarningMessage() {
          return "Trust control release"
        },
      },
    }
    const run = method(native, metadata, parseCatalog, Failure, "raya.secondBrain.control.catalog")
    await run.call({
      settings: value.settings,
      service: value.service,
      context: { globalState: value.storage },
      control: value.control,
    })
    expect(value.storage.get("raya.secondBrain.control.catalog")).toBeDefined()
    expect(value.owner.valid()).toBe(true)
    expect(value.held.child.exitCode).toBeNull()
    expect(await value.settings.load()).toBeDefined()
    await expect(
      value.service.configure(async () => {
        await value.settings.load()
      }),
    ).rejects.toThrow("launch")
    expect(value.held.child.exitCode).toBe(0)
    expect(value.held.eof).toEqual({ stdout: true, stderr: true })
    const closed = JSON.parse(await readFile(path.join(value.dir, "managed-closed.json"), "utf8"))
    expect(closed.selected.path).toBe(path.join(value.dir, "managed-reservation.json"))
    expect(closed.original.path).toBe(path.join(value.dir, "managed-original.json"))
    expect(closed.closure.nativeFamilyRetirement).toBe(false)
    await value.service.disconnect()
    expect(await value.settings.load()).toBeUndefined()
  } finally {
    await value.service.dispose().catch((err: unknown) => expect(err).toBeInstanceOf(Error))
    await rm(value.dir, { recursive: true, force: true })
  }
}, 30000)

for (const field of ["credential", "managed", "debt"] as const) {
  test(`same-setup ${field} replacement during native catalog review is refused without retiring or adopting the current original`, async () => {
    const value = await retained()
    try {
      const method = await catalog()
      const native = {
        window: {
          async showOpenDialog() {
            return [{ scheme: "file", fsPath: value.selection }]
          },
          async showWarningMessage() {
            const row = value.storage.get<Record<string, unknown>>("raya.secondBrain.setup")!
            if (field === "credential") row.credential = "raya.secondBrain.key." + crypto.randomUUID()
            if (field === "managed")
              row.managed = { ...selected(), root: value.dir, plan: { ...selected().plan, sha256: "c".repeat(64) } }
            if (field !== "debt") await value.storage.update("raya.secondBrain.setup", row)
            if (field === "debt")
              await value.settings.record({
                format: "raya.memory.control.uncertainty",
                version: 2,
                protocol: "raya.memory.operation.v1",
                root: "C:\\Synthetic\\Notes",
                request: {
                  op: "sync",
                  id: "b".repeat(32),
                  root: "C:\\Synthetic\\Notes",
                  owner_epoch: "c".repeat(32),
                  selected_release_sha256: "d".repeat(64),
                  bodySHA: "e".repeat(64),
                  source_sha256: release,
                  expected: "f".repeat(64),
                },
              })
            return "Trust control release"
          },
        },
      }
      const run = method(native, metadata, parseCatalog, Failure, "raya.secondBrain.control.catalog")
      await expect(
        run.call({
          settings: value.settings,
          service: value.service,
          context: { globalState: value.storage },
          control: value.control,
        }),
      ).rejects.toThrow()
      expect(value.storage.get("raya.secondBrain.control.catalog")).toBeUndefined()
      expect(value.owner.valid()).toBe(true)
      expect(value.held.child.exitCode).toBeNull()
      await expect(value.service.dispose()).rejects.toThrow()
      expect(value.held.eof).toEqual({ stdout: true, stderr: true })
      expect(await Bun.file(path.join(value.dir, "managed-closed.json")).exists()).toBe(true)
      if (field === "debt") expect(value.settings.pending()).toBeDefined()
    } finally {
      await value.service.dispose().catch((err: unknown) => expect(err).toBeInstanceOf(Error))
      await rm(value.dir, { recursive: true, force: true })
    }
  }, 30000)
}

test("a changed exact entry after catalog publication refuses acceptance and retains the written metadata evidence", async () => {
  const value = await retained()
  try {
    const method = await catalog()
    const native = {
      window: {
        async showOpenDialog() {
          return [{ scheme: "file", fsPath: value.selection }]
        },
        async showWarningMessage() {
          return "Trust control release"
        },
      },
    }
    const run = method(native, metadata, parseCatalog, Failure, "raya.secondBrain.control.catalog")
    const storage = {
      async update(name: string, data: unknown) {
        await value.storage.update(name, data)
        const row = value.storage.get<Record<string, unknown>>("raya.secondBrain.setup")!
        row.credential = "raya.secondBrain.key." + crypto.randomUUID()
        await value.storage.update("raya.secondBrain.setup", row)
      },
    }
    await expect(
      run.call({
        settings: value.settings,
        service: value.service,
        context: { globalState: storage },
        control: value.control,
      }),
    ).rejects.toThrow("publication")
    expect(value.storage.get("raya.secondBrain.control.catalog")).toBeDefined()
    expect(value.owner.valid()).toBe(true)
    await expect(value.settings.load()).rejects.toThrow()
    await expect(value.service.dispose()).rejects.toThrow()
    expect(value.held.eof).toEqual({ stdout: true, stderr: true })
    expect(await Bun.file(path.join(value.dir, "managed-closed.json")).exists()).toBe(true)
  } finally {
    await value.service.dispose().catch((err: unknown) => expect(err).toBeInstanceOf(Error))
    await rm(value.dir, { recursive: true, force: true })
  }
}, 30000)

test("actual managed preflight failure remains the original failure while repeated service disposal produces no child or closed authority", async () => {
  const dir = await root()
  const file = path.join(dir, "settings.json")
  await writeFile(file, "{}")
  const storage = {
    get<T>(name: string) {
      return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
    },
    async update(name: string, value: unknown) {
      const data = JSON.parse(await readFile(file, "utf8"))
      data[name] = value
      await writeFile(file, JSON.stringify(data))
    },
  }
  const settings = new BrainSettings(storage, {
    async get() {
      return "synthetic"
    },
    async store() {
      return undefined
    },
    async delete() {
      return undefined
    },
  })
  const setup = {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    origin: "http://127.0.0.1:8874",
    root: "C:\\Synthetic\\Notes",
    source_sha256: release,
  }
  const cfg = descriptor({ ...selected(), root: dir })
  await settings.save(setup, "synthetic", cfg)
  const service = new BrainService(settings, path.resolve("."))
  const before = await readFile(file)
  try {
    // The actual descriptor has deliberately wrong image byte counts. Actual
    // selection refuses before packaged-helper admission/reservation/spawn.
    const failure = await service
      .run(undefined, () => undefined)
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(failure).toBeInstanceOf(Error)
    const owner = Reflect.get(service, "managed") as ManagedOwner
    expect(owner).toBeInstanceOf(ManagedOwner)
    expect(Reflect.get(owner, "pipes")).toBeUndefined()
    expect(owner.valid()).toBe(false)
    await expect(owner.open()).rejects.toThrow("cannot be replaced")
    const ending = owner.close()
    expect(owner.close()).toBe(ending)
    await ending
    await service.dispose()
    await service.dispose()
    expect(await readFile(file)).toEqual(before)
    expect(settings.pending()).toBeUndefined()
    for (const name of ["managed-reservation.json", "managed-original.json", "managed-closed.json"])
      expect(await Bun.file(path.join(dir, name)).exists()).toBe(false)
    expect(owner.valid()).toBe(false)
    await expect(service.run(undefined, () => undefined)).rejects.toThrow("closed")
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
