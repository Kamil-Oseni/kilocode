import { afterAll, beforeAll, expect, test, spyOn } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runtime } from "./fixtures/native-memory-runtime"
import { protect } from "../../src/second-brain/control/protection"
import { materialize } from "../../src/second-brain/managed/materialize"
import { review } from "../../src/second-brain/managed/upgrade-review"
import { selection, type Descriptor } from "../../src/second-brain/managed/descriptor"
import type { Setup } from "../../src/second-brain/settings"
import { images, fingerprint, cohort } from "../../src/second-brain/managed/reuse-catalog"
import { release } from "../../src/second-brain/control/catalog-capture"
import { image } from "../../src/second-brain/control/identity"
import { document, child, sha } from "../../src/second-brain/control/frames"
import { command } from "../../src/second-brain/control/command"
import * as projection from "../../src/second-brain/managed/upgrade"
import { scope, dispose } from "../../src/second-brain/managed/projection-cache"
import { project } from "../../src/second-brain/managed/upgrade"
import { observe } from "../../src/second-brain/managed/upgrade-observe-v2"
import { fresh } from "../../src/second-brain/managed/generation"
import { observe as historical } from "../../src/second-brain/managed/upgrade-observe"
import { exec } from "../../src/util/process"

let outer: string
let cfg: Descriptor
let setup: Setup
async function archive(name: string) {
  const result = await exec("git", ["show", "44967c2bdc:" + name], { maxBuffer: 1048576, timeout: 10000 })
  return Buffer.from(result.stdout)
}

async function history(dir: string) {
  const extension = path.join(dir, "extension")
  const base = path.join(extension, "script/memory")
  const modules = path.join(dir, "recipe")
  await mkdir(modules)
  for (const name of ["catalog-capture", "catalog-v2"])
    await writeFile(
      path.join(modules, name + ".ts"),
      await archive("packages/kilo-vscode/src/second-brain/control/" + name + ".ts"),
    )
  for (const name of ["materialize", "upgrade", "upgrade-observe", "catalog"]) {
    const raw = await archive("packages/kilo-vscode/src/second-brain/managed/" + name + ".ts")
    const bound = raw.toString().replace(/from "([^"]+)"/g, (match, spec: string) => {
      if (spec.startsWith("node:")) return match
      if (spec === "../control/catalog-capture") return 'from "./catalog-capture"'
      if (["./upgrade", "./upgrade-observe", "./catalog"].includes(spec)) return match
      return "from " + JSON.stringify(path.resolve("src/second-brain/managed", spec) + ".ts")
    })
    await writeFile(path.join(modules, name + ".ts"), bound)
  }
  const captured = (await import(pathToFileURL(path.join(modules, "catalog-capture.ts")).href)) as {
    release: Readonly<Record<string, string>>
  }
  expect(Object.keys(captured.release)).toHaveLength(13)
  const old = "6e0cb18e4c8e1fdeba4e8992dca898cc94ddafacce3e31a79b364b3d42697c86"
  const pins = cohort(old)
  for (const [name, digest] of [
    ...Object.entries(captured.release).map(([name, digest]) => ["service/" + name, digest]),
    ...Object.entries(pins),
  ]) {
    const raw = await archive("packages/kilo-vscode/script/memory/" + name)
    expect(sha(raw)).toBe(digest)
    const target = path.join(base, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, raw)
  }
  const supervisor = await archive("packages/kilo-vscode/script/memory/supervise.py")
  expect(sha(supervisor)).toBe("a18db2a202bdd20c1a62209eefc1cfd5d89a5e27b56169f65cf0927cdf159d0b")
  await writeFile(path.join(base, "supervise.py"), supervisor)
  return { extension, base, modules, captured: captured.release, old, pins, supervisor }
}
beforeAll(async () => {
  outer = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-activation-"))
  await protect(outer)
  const notes = path.join(outer, "notes")
  await mkdir(path.join(notes, "System"), { recursive: true })
  const selected = await runtime(outer, undefined, notes)
  cfg = selected.cfg
  setup = selected.setup
}, 30000)
afterAll(async () => {
  expect(path.dirname(outer)).toBe(path.resolve(os.tmpdir()))
  expect(path.basename(outer).startsWith("raya-memory-control-activation-")).toBe(true)
  await rm(outer, { recursive: true })
})

test("v2 activates both native selections, preserves original integer tokens and refuses damaged cold review", async () => {
  const before = await selection(cfg, setup)
  const value = await materialize(cfg, setup, path.resolve("."), "3".repeat(32))
  expect(value.version).toBe(2)
  expect("retrieval" in value).toBe(true)
  if (!("retrieval" in value)) throw new Error("V2 fixture required")
  expect(value.images).toHaveLength(Object.keys(release).length + Object.keys(images).length + 1)
  expect(value.original).toHaveLength(Object.keys(release).length)
  expect(value.retrieval.previous.images).toHaveLength(16)
  const after = await selection(value.next.managed, value.next.setup)
  expect(after.retrieval!.source_sha256).toEqual(images)
  expect(after.retrieval!.source).toBe(value.source)
  expect(after.retrieval!.env.RAYA_RETRIEVAL_RELEASE_SHA256).toBe(fingerprint)
  expect(after.plan.env.RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256).toBe(fingerprint)
  expect(value.next.managed.python).toEqual(cfg.python)
  expect(value.next.managed.notes).toEqual(cfg.notes)
  for (const name of [
    "RAYA_MEMORY_TOKEN_FILE",
    "RAYA_MEMORY_RETRIEVAL_TOKEN_FILE",
    "RAYA_MEMORY_NOTE_GENERATIONS",
    "RAYA_MEMORY_ROOT",
  ])
    expect(after.plan.env[name]).toEqual(before.plan.env[name])
  const inspected = await review(value.receipt, { setup, managed: cfg })
  expect(inspected.next).toEqual(value.next)
  const prior = {
    source: value.retrieval.previous.source,
    pins: value.retrieval.previous.pins,
    release: value.retrieval.previous.release,
  }
  const observed = await observe(cfg, prior, value.source, value.next.managed.namespaces)
  const mapping = new Map(
    observed.images
      .filter((row) => path.basename(row.path) !== "supervise.py")
      .map((row) => {
        const name = path.relative(value.source, row.path)
        return [path.join(name.includes(path.sep) ? prior.source : String(before.plan.source), name), row] as const
      }),
  )
  const supervisor = observed.images.find((row) => path.basename(row.path) === "supervise.py")!
  const bound = { previous: prior, directories: observed.directories.slice(1) }
  const original = before.files[2].raw
  const raw = Buffer.from(
    original.toString().replace(/}$/, ',"retained":{"identity":[18446744073709551615,1791503155482873601]}}'),
  )
  const result = project(
    raw,
    value.source,
    release,
    mapping,
    supervisor,
    observed.directories[0],
    { path: String(before.plan.source), pins: setup.source_sha256 },
    bound,
  )
  const parsed = document(result, 16777216, 1000000)
  const retained = child(parsed.tree, "retained")
  expect(parsed.text.slice(retained.offset, retained.offset + retained.length)).toBe(
    '{"identity":[18446744073709551615,1791503155482873601]}',
  )
  const omitted = new Map(mapping)
  omitted.delete(path.join(prior.source, "retrieval/owner.py"))
  expect(() =>
    project(
      raw,
      value.source,
      release,
      omitted,
      supervisor,
      observed.directories[0],
      { path: String(before.plan.source), pins: setup.source_sha256 },
      bound,
    ),
  ).toThrow("inventory")
  const originalReceipt = await readFile(value.receipt.path)
  const damaged = {
    ...JSON.parse(originalReceipt.toString()),
    retrieval: { ...value.retrieval, next: { ...value.retrieval.next, release: "f".repeat(64) } },
  }
  await writeFile(value.receipt.path, JSON.stringify(damaged))
  const ref = await image(value.receipt.path)
  await expect(
    review({ path: value.receipt.path, bytes: ref.raw.length, sha256: ref.digest }, { setup, managed: cfg }),
  ).rejects.toThrow("provenance")
  await writeFile(value.receipt.path, originalReceipt)
  const leaf = path.join(value.source, "retrieval_reuse/pool.py")
  const bytes = await readFile(leaf)
  await writeFile(leaf, Buffer.concat([bytes, Buffer.from("\n")]))
  await expect(review(value.receipt, { setup, managed: cfg })).rejects.toThrow()
  await writeFile(leaf, bytes)
  const originalSelected = await selection(cfg, setup)
  expect(originalSelected.files.map((row) => row.digest)).toEqual(before.files.map((row) => row.digest))
  expect(originalSelected.files.map((row) => row.tuple)).toEqual(before.files.map((row) => row.tuple))
}, 30000)

test("explicit v1 remains Memory-only and cannot be relabeled as v2 activation", async () => {
  const before = await selection(cfg, setup)
  const value = await materialize(cfg, setup, path.resolve("."), "4".repeat(32), 1)
  expect(value.version).toBe(1)
  expect(value).not.toHaveProperty("retrieval")
  expect(value.images).toHaveLength(Object.keys(release).length + 1)
  const next = await selection(value.next.managed, value.next.setup)
  expect(next.retrieval!.source).toBe(before.retrieval!.source)
  expect(next.retrieval!.source_sha256).toEqual(before.retrieval!.source_sha256)
  expect((await review(value.receipt, { setup, managed: cfg })).next).toEqual(value.next)
  const raw = await readFile(value.receipt.path)
  await writeFile(value.receipt.path, JSON.stringify({ ...JSON.parse(raw.toString()), version: 2 }))
  const changed = await image(value.receipt.path)
  await expect(
    review({ path: value.receipt.path, bytes: changed.raw.length, sha256: changed.digest }, { setup, managed: cfg }),
  ).rejects.toThrow("metadata")
}, 30000)

test("native supervisor validates a current finite Retrieval plan without importing models", async () => {
  const dir = path.join(outer, "raya-memory-control-finite")
  await mkdir(dir)
  const finite = await runtime(dir)
  const files = await Promise.all(
    [finite.cfg.python, finite.cfg.supervisor, finite.cfg.plan, finite.cfg.retrieval!].map(async (ref) => {
      const held = await image(ref.path, 16777216)
      expect(held.raw.length).toBe(ref.bytes)
      expect(held.digest).toBe(ref.sha256)
      return held
    }),
  )
  const current = await fresh(finite.cfg, path.join(finite.cfg.root, "raya-memory-fresh-" + "5".repeat(32)), files)
  const body = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('owned_supervisor',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:
 for file,digest in json.loads(sys.argv[2]): module.load(file,digest,True)
except Exception as error:
 print('native-refusal:'+type(error).__name__+':'+str(error));raise SystemExit(0)
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print('finite-qualified')`
  const result = await command(
    finite.cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      body,
      current.supervisor.path,
      JSON.stringify([current.retrieval].map((ref) => [ref!.path, ref!.sha256])),
    ],
    { windowsHide: true },
  )
  expect(result.stdout.trim()).toBe("finite-qualified")
}, 30000)

test("historical v1 native observer and projection retain the immutable original program and known supervisor", async () => {
  const dir = path.join(outer, "raya-memory-control-history-observer")
  await mkdir(dir)
  await protect(dir)
  const notes = path.join(dir, "notes")
  await mkdir(path.join(notes, "System"), { recursive: true })
  const saved = await history(dir)
  const selected = await runtime(dir, { path: path.join(saved.base, "service"), pins: saved.captured }, notes, {
    path: saved.base,
    pins: saved.pins,
    release: saved.old,
    supervisor: path.join(saved.base, "supervise.py"),
  })
  const original = await selection(selected.cfg, selected.setup)
  const source = path.join(selected.cfg.root, "raya-memory-source-upgrade-" + "6".repeat(32))
  await mkdir(source)
  for (const name of Object.keys(saved.captured))
    await copyFile(path.join(saved.base, "service", name), path.join(source, name))
  const raw = saved.supervisor
  const expected = "a18db2a202bdd20c1a62209eefc1cfd5d89a5e27b56169f65cf0927cdf159d0b"
  expect(sha(raw)).toBe(expected)
  await writeFile(path.join(source, "supervise.py"), raw)
  const archived = (await import(pathToFileURL(path.join(saved.modules, "upgrade-observe.ts")).href)) as {
    observe: typeof historical
  }
  const projected = (await import(pathToFileURL(path.join(saved.modules, "upgrade.ts")).href)) as {
    project: typeof project
  }
  const observed = await archived.observe(selected.cfg, source, undefined, expected)
  expect(observed.images).toHaveLength(14)
  expect(observed.producer).toMatchObject({
    code: 0,
    originalJoined: true,
    readersJoined: true,
    forced: false,
    stdoutEOF: true,
    stderrEOF: true,
  })
  const legacy = await exec(
    "git",
    ["show", "44967c2bdc:packages/kilo-vscode/src/second-brain/managed/upgrade-observe.ts"],
    { maxBuffer: 1048576, timeout: 10000 },
  )
  // Evaluate only the two original immutable string constants; no imports, worker or model code executes.
  const constants = legacy.stdout.slice(legacy.stdout.indexOf("const body ="), legacy.stdout.indexOf("type Image ="))
  const program = new Function(constants + "\nreturn script")() as string
  expect(observed.programSHA).toBe(sha(program))
  await expect(historical(selected.cfg, source)).rejects.toThrow("Native upgrade observation refused")
  const supervisor = observed.images.find((row) => path.basename(row.path) === "supervise.py")!
  const mapping = new Map(
    observed.images
      .filter((row) => path.basename(row.path) !== "supervise.py")
      .map((row) => [path.join(String(original.plan.source), path.basename(row.path)), row]),
  )
  const base = { path: String(original.plan.source), pins: selected.setup.source_sha256 }
  for (const index of [2, 3]) {
    const changed = projected.project(
      original.files[index].raw,
      source,
      saved.captured,
      mapping,
      supervisor,
      observed.directory!,
      base,
      undefined,
      expected,
    )
    const parsed = document(changed, 16777216, 1000000).value as Record<string, unknown>
    expect(parsed.source).toBe(index === 2 ? source : original.retrieval!.source)
    expect(parsed.env).toEqual(index === 2 ? original.plan.env : original.retrieval!.env)
    expect(() =>
      project(original.files[index].raw, source, saved.captured, mapping, supervisor, observed.directory!, base),
    ).toThrow()
  }
}, 30000)

test("an actual archived v1 recipe creates an immutable old-cohort artifact that current cold review accepts", async () => {
  const dir = path.join(outer, "raya-memory-control-history")
  await mkdir(dir)
  await protect(dir)
  const notes = path.join(dir, "notes")
  await mkdir(path.join(notes, "System"), { recursive: true })
  const saved = await history(dir)
  const extension = saved.extension
  const base = saved.base
  const modules = saved.modules
  const old = saved.old
  const pins = saved.pins
  const supervisor = saved.supervisor
  const selected = await runtime(dir, { path: path.join(base, "service"), pins: saved.captured }, notes, {
    path: base,
    pins,
    release: old,
    supervisor: path.join(base, "supervise.py"),
  })
  const before = await selection(selected.cfg, selected.setup)
  const recipe = (await import(
    pathToFileURL(path.join(modules, "materialize.ts")).href
  )) as typeof import("../../src/second-brain/managed/materialize")
  const prepared = await recipe.materialize(selected.cfg, selected.setup, extension, "7".repeat(32))
  expect(prepared.version).toBe(1)
  expect(prepared).not.toHaveProperty("retrieval")
  expect(prepared.images).toHaveLength(14)
  expect(prepared.next.managed.supervisor.sha256).toBe(sha(supervisor))
  expect(prepared.producer).toMatchObject({
    code: 0,
    originalJoined: true,
    readersJoined: true,
    forced: false,
    stdoutEOF: true,
    stderrEOF: true,
  })
  const original = await image(prepared.receipt.path)
  const reviewed = await review(prepared.receipt, { setup: selected.setup, managed: selected.cfg })
  expect(reviewed.next).toEqual(prepared.next)
  const after = await selection(selected.cfg, selected.setup)
  expect(after.files.map((row) => row.tuple)).toEqual(before.files.map((row) => row.tuple))
  expect(after.files.map((row) => row.digest)).toEqual(before.files.map((row) => row.digest))
  const unchanged = await image(prepared.receipt.path)
  expect(unchanged.tuple).toBe(original.tuple)
  expect(unchanged.raw).toEqual(original.raw)
  expect(unchanged.digest).toBe(prepared.receipt.sha256)
  const finiteRoot = path.join(dir, "raya-memory-control-historical-finite")
  await mkdir(finiteRoot)
  const finite = await runtime(finiteRoot, { path: path.join(base, "service"), pins: saved.captured }, undefined, {
    path: base,
    pins,
    release: old,
    supervisor: path.join(base, "supervise.py"),
  })
  const files = await Promise.all(
    [finite.cfg.python, finite.cfg.supervisor, finite.cfg.plan, finite.cfg.retrieval!].map(async (ref) => {
      const held = await image(ref.path, 16777216)
      expect(held.raw.length).toBe(ref.bytes)
      expect(held.digest).toBe(ref.sha256)
      return held
    }),
  )
  const protectedPlan = await fresh(
    finite.cfg,
    path.join(finite.cfg.root, "raya-memory-fresh-" + "8".repeat(32)),
    files,
  )
  const native = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('current_supervisor',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
plan,_=module.load(sys.argv[2],sys.argv[3],True)
assert plan['source_sha256']==module.FINITE_PREVIOUS
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print('retained-finite-qualified')`
  const observed = await command(
    finite.cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      native,
      path.resolve("script/memory/supervise.py"),
      protectedPlan.retrieval!.path,
      protectedPlan.retrieval!.sha256,
    ],
    { windowsHide: true },
  )
  expect(observed.stdout.trim()).toBe("retained-finite-qualified")
}, 30000)

test("request-owned projection hits retain genuine native validation and refuse source drift", async () => {
  const value = await materialize(cfg, setup, path.resolve("."), "9".repeat(32))
  const cache = scope()
  const held = spyOn(projection, "project")
  try {
    const first = await review(value.receipt, { setup, managed: cfg }, cache)
    const count = held.mock.calls.length
    expect(count).toBe(2)
    const second = await review(value.receipt, { setup, managed: cfg }, cache)
    expect(second.next).toEqual(first.next)
    expect(held.mock.calls.length).toBe(count)
    dispose(cache)
    await review(value.receipt, { setup, managed: cfg }, cache)
    expect(held.mock.calls.length).toBe(count + 2)
    const active = scope()
    await review(value.receipt, { setup, managed: cfg }, active)
    const latest = held.mock.calls.length
    const leaf = path.join(value.source, "index.py")
    const bytes = await readFile(leaf)
    try {
      await writeFile(leaf, Buffer.concat([bytes, Buffer.from("\n")]))
      await expect(review(value.receipt, { setup, managed: cfg }, active)).rejects.toThrow()
      expect(held.mock.calls.length).toBe(latest)
    } finally {
      await writeFile(leaf, bytes)
      dispose(active)
    }
  } finally {
    held.mockRestore()
    dispose(cache)
  }
}, 30000)
