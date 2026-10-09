import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { materialize } from "../../src/second-brain/managed/materialize"
import { review } from "../../src/second-brain/managed/upgrade-review"
import { publish, inspect } from "../../src/second-brain/managed/upgrade-publish"
import { generation, review as successor } from "../../src/second-brain/managed/generation"
import { launch } from "../../src/second-brain/managed/restart"
import { lineage } from "../../src/second-brain/managed/upgrade-lineage"
import { descriptor, paired, selection, type Descriptor } from "../../src/second-brain/managed/descriptor"
import { current } from "../../src/second-brain/managed/catalog"
import { images, fingerprint } from "../../src/second-brain/managed/reuse-catalog"
import { release, bridge } from "../../src/second-brain/control/catalog-capture"
import { fingerprint as digest } from "../../src/second-brain/failed-repair"
import { command } from "../../src/second-brain/control/command"
import { image } from "../../src/second-brain/control/identity"
import { runtime } from "./fixtures/native-memory-runtime"
import { observe } from "../../src/second-brain/managed/upgrade-observe"
import { parse, type Setup } from "../../src/second-brain/settings"

let outer: string
let cfg: Descriptor
let setup: Setup

beforeAll(async () => {
  outer = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-materialize-"))
  const value = await runtime(outer)
  cfg = value.cfg
  setup = value.setup
}, 30000)

afterAll(async () => {
  if (!outer) return
  expect(path.dirname(outer)).toBe(os.tmpdir())
  expect(path.basename(outer).startsWith("raya-memory-control-materialize-")).toBe(true)
  await rm(outer, { recursive: true })
})

test("materialize retains old native images and creates qualified independent plans/namespaces with no models", async () => {
  const original = await selection(cfg, setup)
  expect(original.plan.directories.some((row: { path: string }) => row.path === cfg.root)).toBe(false)
  const next = await materialize(cfg, setup, path.resolve("."), "a".repeat(32))
  const result = await selection(next.next.managed, next.next.setup)
  expect(next.source).toBe(path.join(cfg.root, "raya-memory-source-upgrade-" + "a".repeat(32)))
  expect(next.next.managed.supervisor.sha256).toBe(current)
  expect(next.next.managed.namespaces).not.toEqual(cfg.namespaces)
  expect(next.next.setup.source_sha256).toEqual(release)
  expect(result.plan.source).toBe(next.source)
  expect(result.plan.files).toEqual(result.retrieval!.files)
  expect(result.plan.directories).toEqual(result.retrieval!.directories)
  expect(result.retrieval!.source).toBe(original.retrieval!.source)
  expect(result.retrieval!.source_sha256).toEqual(original.retrieval!.source_sha256)
  const after = await selection(cfg, setup)
  expect(after.files.map((item) => item.tuple)).toEqual(original.files.map((item) => item.tuple))
  expect(after.files.map((item) => item.digest)).toEqual(original.files.map((item) => item.digest))
  expect(next.producer).toMatchObject({
    code: 0,
    stdoutEOF: true,
    stderrEOF: true,
    originalJoined: true,
    readersJoined: true,
    forced: false,
    observationExpired: false,
  })
  expect(next.requestSettlement).toBe(false)
  expect(next.replay).toBe(false)
  expect(next.indexConfirmed).toBe(false)
  expect((await image(next.receipt.path)).digest).toBe(next.receipt.sha256)
  const reviewed = await review(next.receipt, { setup, managed: cfg })
  expect(reviewed.next).toEqual(next.next)
  expect(reviewed.producer).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
  await expect(review({ ...next.receipt, sha256: "f".repeat(64) }, { setup, managed: cfg })).rejects.toThrow(
    "Prepared upgrade receipt changed",
  )
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('actual_upgrade_supervisor',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for file,digest in json.loads(sys.argv[2]): module.load(file,digest,True)
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print('two-native-plans-qualified-without-models')`
  const observed = await command(
    cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      script,
      next.next.managed.supervisor.path,
      JSON.stringify([next.next.managed.plan, next.next.managed.retrieval!].map((item) => [item.path, item.sha256])),
    ],
    { windowsHide: true },
  )
  expect(observed.stdout.trim()).toBe("two-native-plans-qualified-without-models")
  await expect(materialize(cfg, setup, path.resolve("."), "a".repeat(32))).rejects.toThrow()
  const collision = path.join(cfg.root, "raya-memory-source-upgrade-" + "b".repeat(32))
  await mkdir(collision)
  await writeFile(path.join(collision, "retain.txt"), "original collision")
  await expect(materialize(cfg, setup, path.resolve("."), "b".repeat(32))).rejects.toThrow()
  expect(await readFile(path.join(collision, "retain.txt"), "utf8")).toBe("original collision")
  expect(
    await stat(path.join(cfg.root, "raya-memory-fresh-" + "b".repeat(32))).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  for (const source of [
    path.join(cfg.root, "foreign"),
    path.join(cfg.root, "raya-memory-source-upgrade-" + "f".repeat(32)),
  ])
    expect(() => paired(next.next.managed, { ...result.plan, source }, result.retrieval!)).toThrow()
  const altered = await materialize(cfg, setup, path.resolve("."), "d".repeat(32))
  const plan = altered.next.managed.plan
  const raw = (await readFile(plan.path, "utf8")).replace(
    '"HOME":' + JSON.stringify(path.join(cfg.root, "home")),
    '"HOME":' + JSON.stringify(path.join(cfg.root, "foreign-home")),
  )
  await writeFile(plan.path, raw)
  const changed = await image(plan.path, 16777216)
  const value = JSON.parse(await readFile(altered.receipt.path, "utf8")) as Omit<typeof altered, "receipt">
  await writeFile(
    altered.receipt.path,
    JSON.stringify({
      ...value,
      next: {
        ...value.next,
        managed: {
          ...value.next.managed,
          plan: { path: plan.path, bytes: changed.raw.length, sha256: changed.digest },
        },
      },
    }),
  )
  const metadata = await image(altered.receipt.path)
  await expect(
    review(
      { path: altered.receipt.path, bytes: metadata.raw.length, sha256: metadata.digest },
      { setup, managed: cfg },
    ),
  ).rejects.toThrow("Derived upgrade plan changed unrelated original bytes")
}, 30000)

test("native upgrade observes root-omitting inventories and refuses changed or duplicate retained directory rows", async () => {
  const original = await image(cfg.plan.path, 16777216)
  expect((await observe(cfg)).prior).toHaveLength(13)
  const script = `import json,pathlib,sys
file=pathlib.Path(sys.argv[1]);plan=json.loads(file.read_bytes());root=pathlib.Path(plan['root']);info=root.lstat()
row={'path':str(root),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]}
for name in ('root','changed','duplicate','missing','source'):
 value={**plan,'directories':list(plan['directories'])}
 if name in ('root','changed','duplicate'):
  value['directories'].append({**row,'identity':list(row['identity'])})
 if name=='changed': value['directories'][-1]['identity'][1]+=1
 if name=='duplicate': value['directories'].append(row)
 if name=='missing': value['directories']=[item for item in value['directories'] if item['path']!=plan['source']]
 if name=='source':
  value['directories']=[{**item,'identity':[item['identity'][0],item['identity'][1]+1,item['identity'][2]]} if item['path']==plan['source'] else item for item in value['directories']]
 (root/('observe-'+name+'.json')).write_text(json.dumps(value,separators=(',',':')),encoding='utf-8')`
  await command(cfg.python.path, ["-I", "-S", "-B", "-c", script, cfg.plan.path], { windowsHide: true })
  for (const name of ["root", "changed", "duplicate", "missing", "source"]) {
    const file = path.join(cfg.root, "observe-" + name + ".json")
    const held = await image(file, 16777216)
    const result = observe({ ...cfg, plan: { path: file, bytes: held.raw.length, sha256: held.digest } })
    if (name === "root") {
      expect((await result).prior).toHaveLength(13)
      continue
    }
    await expect(result).rejects.toThrow("original_upgrade_directory_changed")
  }
  const retained = await image(cfg.plan.path, 16777216)
  expect(retained.digest).toBe(original.digest)
  expect(retained.tuple).toBe(original.tuple)
}, 30000)

test("upgraded source metadata admits only its exact historical or current supervisor cohort", async () => {
  const next = await materialize(cfg, setup, path.resolve("."), "e".repeat(32))
  const selected = await selection(next.next.managed, next.next.setup)
  const pins = { ...release, "index.py": "8ae8274ff8f46f906efc9c6c5e2dbd2445315f27dc371bd07485fb71635f20f3" }
  const prior = {
    ...next.next.managed,
    supervisor: {
      ...next.next.managed.supervisor,
      sha256: "a1128d8f746e5827127a67a2c6e022c72e405a4598b3eed790b8a672a3427dd4",
    },
  }
  const files = (selected.plan.files as { path: string; sha256: string }[]).map((row) =>
    row.path === path.join(next.source, "index.py") ? { ...row, sha256: pins["index.py"] } : row,
  )
  const memory = { ...selected.plan, source_sha256: pins, files }
  const retrieval = { ...selected.retrieval!, files }
  // Schema-only admission checks; altered fixture metadata is not a native image or launch proof.
  expect(() => paired(prior, memory, retrieval)).not.toThrow()
  expect(() => paired(next.next.managed, selected.plan, selected.retrieval!)).not.toThrow()
  expect(() => paired(next.next.managed, memory, retrieval)).toThrow("Paired source directory differs")
  expect(() => paired(prior, selected.plan, selected.retrieval!)).toThrow("Paired source directory differs")
  expect(() =>
    paired({ ...prior, supervisor: { ...prior.supervisor, sha256: "f".repeat(64) } }, memory, retrieval),
  ).toThrow("Paired source directory differs")
  expect(() =>
    paired(prior, { ...memory, source_sha256: { ...pins, "server.py": "f".repeat(64) } }, retrieval),
  ).toThrow("Paired source directory differs")
  for (const source of [
    path.join(next.source, "nested"),
    path.join(cfg.root, "foreign"),
    path.join(cfg.root, "raya-memory-source-upgrade-" + "f".repeat(32)),
  ])
    expect(() => paired(prior, { ...memory, source }, retrieval)).toThrow("Paired source directory differs")
}, 30000)

test("reusable v2 upgrade retains its independent release and external notes witness", async () => {
  const notes = path.join(outer, "external-notes")
  await mkdir(path.join(notes, "System"), { recursive: true })
  await writeFile(path.join(notes, "README.md"), "# Retained synthetic external note\n")
  for (const name of Object.keys(images)) {
    const file = path.join(cfg.root, "source", name)
    await mkdir(path.dirname(file), { recursive: true })
    if (name.startsWith("retrieval_reuse/")) await copyFile(path.join("script/memory", name), file)
  }
  const script = `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);notes=pathlib.Path(sys.argv[2]);pins=json.loads(sys.argv[3]);release=sys.argv[4]
memory=json.loads((root/'memory-plan.json').read_bytes());other=json.loads((root/'retrieval-plan.json').read_bytes());files=list(memory['files']);directories=list(memory['directories'])
for name,digest in pins.items():
 file=root/'source'/name
 if name.startswith('retrieval_reuse/'):
  raw=file.read_bytes();info=file.lstat();assert hashlib.sha256(raw).hexdigest()==digest
  files.append({'path':str(file),'bytes':len(raw),'sha256':digest,'identity':[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink]})
folder=root/'source'/'retrieval_reuse';info=folder.lstat();directories.append({'path':str(folder),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]})
generations={}
for name,file in (('root',notes),('system',notes/'System')):
 info=file.lstat();generations[name]=[info.st_dev,info.st_ino,info.st_birthtime_ns]
memory.update(files=files,directories=directories,notes_selection={'root':str(notes),'system':str(notes/'System'),'generations':{name:[str(value) for value in row] for name,row in generations.items()}})
memory['env'].update(RAYA_MEMORY_ROOT=str(notes),RAYA_MEMORY_NOTE_GENERATIONS=json.dumps(generations,separators=(',',':')),RAYA_MEMORY_RETRIEVAL_PROTOCOL='raya.retrieval.request.settlement.v2',RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256=release)
other.update(files=files,directories=directories,source=str(root/'source'),source_sha256=pins,retrieval_protocol='raya.retrieval.request.settlement.v2')
other['env']['RAYA_RETRIEVAL_RELEASE_SHA256']=release
result={}
for name,value in (('memory-v2-plan.json',memory),('retrieval-v2-plan.json',other)):
 file=root/name;raw=json.dumps(value,separators=(',',':')).encode();file.write_bytes(raw);result[name]={'path':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
result['notes']=memory['notes_selection'];print(json.dumps(result,separators=(',',':')))`
  const output = await command(
    cfg.python.path,
    ["-I", "-S", "-B", "-c", script, cfg.root, notes, JSON.stringify(images), fingerprint],
    { windowsHide: true },
  )
  const refs = JSON.parse(output.stdout) as Record<string, unknown>
  const managed = descriptor({
    ...cfg,
    plan: refs["memory-v2-plan.json"],
    retrieval: refs["retrieval-v2-plan.json"],
    notes: refs.notes,
  })
  const selected = parse({ ...setup, protocol: "raya.memory.operation.v2", root: notes })
  const before = await readFile(path.join(notes, "README.md"))
  const next = await materialize(managed, selected, path.resolve("."), "e".repeat(32))
  const cold = await review(next.receipt, { setup: selected, managed })
  expect(cold.next.managed.notes).toEqual(managed.notes)
  expect(cold.next.setup.root).toBe(notes)
  const plans = await selection(cold.next.managed, cold.next.setup)
  expect(plans.retrieval!.source_sha256).toEqual(images)
  expect((plans.plan.env as Record<string, unknown>).RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256).toBe(fingerprint)
  const check = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('actual_v2_upgrade',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for file,digest in json.loads(sys.argv[2]): module.load(file,digest,True)
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print('reusable-v2-external-notes-qualified')`
  const result = await command(
    cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      check,
      cold.next.managed.supervisor.path,
      JSON.stringify([cold.next.managed.plan, cold.next.managed.retrieval!].map((item) => [item.path, item.sha256])),
    ],
    { windowsHide: true },
  )
  expect(result.stdout.trim()).toBe("reusable-v2-external-notes-qualified")
  expect(await readFile(path.join(notes, "README.md"))).toEqual(before)
}, 30000)

test("successor review reconstructs actual native plans and refuses unrelated bytes or namespace witnesses", async () => {
  const prepared = await materialize(cfg, setup, path.resolve("."), "1".repeat(32))
  const selected = prepared.next.managed
  const before = await selection(selected, prepared.next.setup)
  const first = await launch(selected, prepared.next.setup)
  const current = await generation(selected, first, before.files)
  const proof = await successor(selected, first, current, before.files)
  expect(proof.namespaces).toEqual(current.namespaces)
  expect(proof.directories).toHaveLength(7)
  const after = await selection(selected, prepared.next.setup)
  expect(after.files.map((item) => item.digest)).toEqual(before.files.map((item) => item.digest))
  expect(after.files.map((item) => item.tuple)).toEqual(before.files.map((item) => item.tuple))
  expect((await lineage(selected, prepared.next.setup, selected, undefined)).generations).toBe(0)
  const inputs = await selection(current, prepared.next.setup)
  const root = await stat(cfg.root, { bigint: true })
  // This inert selected-phase receipt describes real files/namespaces; it asserts no live producer or closure.
  const file = path.join(first.root, "managed-reservation.json")
  const metadata = {
    format: "raya.memory.managed.pair.selected",
    version: 2,
    descriptor: current,
    rootIdentity: [root.dev, root.ino, root.birthtimeNs].map(String),
    images: inputs.files.map((item, index) => ({
      ref: [current.python, current.supervisor, current.plan, current.retrieval][index],
      sha256: item.digest,
      tuple: item.tuple,
    })),
    containment: "two original processes and their pipes only",
  }
  await writeFile(file, JSON.stringify(metadata))
  const receipt = await image(file)
  const state = {
    phase: "selected",
    receipt: { path: file, bytes: receipt.raw.length, sha256: receipt.digest, tuple: receipt.tuple },
  }
  expect((await lineage(selected, prepared.next.setup, current, state)).generations).toBe(1)
  await expect(lineage(selected, prepared.next.setup, current, { ...state, phase: "running" })).rejects.toThrow(
    "Exact runtime lineage phase receipt required",
  )
  await expect(lineage(selected, prepared.next.setup, selected, state)).rejects.toThrow(
    "Current runtime differs from reviewed successor lineage",
  )
  const raw = await readFile(current.plan.path)
  const value = JSON.parse(raw.toString("utf8")) as { env: Record<string, string> }
  await writeFile(
    current.plan.path,
    JSON.stringify({ ...value, env: { ...value.env, HOME: path.join(outer, "foreign-home") } }),
  )
  const changed = await image(current.plan.path)
  await expect(
    successor(
      selected,
      first,
      { ...current, plan: { path: current.plan.path, bytes: changed.raw.length, sha256: changed.digest } },
      before.files,
    ),
  ).rejects.toThrow("Successor changed unrelated original plan bytes")
  await writeFile(current.plan.path, raw)
  const witness = current.namespaces.memory.generations.root
  await expect(
    successor(
      selected,
      first,
      {
        ...current,
        namespaces: {
          ...current.namespaces,
          memory: {
            ...current.namespaces.memory,
            generations: {
              ...current.namespaces.memory.generations,
              root: [witness[0], witness[1], String(BigInt(witness[2]) + 1n)],
            },
          },
        },
      },
      before.files,
    ),
  ).rejects.toThrow("Successor native namespace witnesses differ")
  await expect(
    successor(selected, first, { ...current, python: { ...current.python, sha256: "a".repeat(64) } }, before.files),
  ).rejects.toThrow("Successor changed immutable runtime selection")
}, 30000)

test("runtime publication survives every physical save acknowledgement loss and a cold applied retry", async () => {
  const prepared = await materialize(cfg, setup, path.resolve("."), "f".repeat(32))
  const key = "raya.secondBrain.setup"
  const pending = "raya.secondBrain.committedCaptureRecovery.pending"
  const ledger = "raya.secondBrain.personalCapture.turns"
  const original = {
    setup,
    managed: cfg,
    credential: "raya.secondBrain.key." + "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12),
  }
  const rows = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      project: outer,
      sessionID: "session",
      messageID: "message",
      source_sha256: "a".repeat(64),
      root: setup.root,
      release: "b".repeat(64),
      phase: "uncertain",
    },
  ]
  const open = async (file: string, fail = 0) => {
    const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    let count = 0
    return {
      get<T>(key: string): T | undefined {
        return structuredClone(state[key]) as T | undefined
      },
      async update(key: string, value: unknown) {
        if (value === undefined) delete state[key]
        if (value !== undefined) state[key] = value
        await writeFile(file, JSON.stringify(state))
        // Read the actual JSON persistence back, including absent slots, before simulating lost acknowledgement.
        const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
        for (const name of Object.keys(state)) delete state[name]
        Object.assign(state, persisted)
        if (++count === fail) throw new Error("physical save acknowledgement lost")
      },
    }
  }
  // Absent catalog/consent are intentionally persisted: JSON must never turn them into null-valued selections.
  for (const failure of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const file = path.join(outer, `publication-${failure}.json`)
    const consent =
      failure === 11
        ? {
            version: 1,
            enabled: true,
            root: setup.root,
            release: digest(setup.source_sha256),
            zone: "America/Toronto",
            model: "pinned-local-model",
            authorization: { source: "Original human authorization", sha256: "c".repeat(64) },
          }
        : undefined
    const catalog = consent
      ? {
          root: setup.root,
          catalog: {
            format: "raya.memory.control.catalog",
            version: 2,
            python: cfg.python.path,
            source: path.join(cfg.root, "source/memory"),
            bridge: path.join(outer, "retained-bridge.py"),
            python_sha256: cfg.python.sha256,
            bridge_sha256: bridge,
            source_sha256: setup.source_sha256,
          },
        }
      : undefined
    await writeFile(
      file,
      JSON.stringify({
        [key]: original,
        [ledger]: rows,
        "raya.secondBrain.personalCapture": consent,
        "raya.secondBrain.control.catalog": catalog,
      }),
    )
    await expect(publish(await open(file, failure === 11 ? 10 : failure), prepared.receipt)).rejects.toThrow(
      "physical save acknowledgement lost",
    )
    const recovered = await publish(await open(file), prepared.receipt)
    expect(recovered.publication.phase).toBe("applied")
    const cold = await open(file)
    expect(cold.get(pending)).toBeUndefined()
    expect(cold.get(ledger)).toEqual(rows)
    expect(cold.get(key)).toEqual({
      setup: prepared.next.setup,
      managed: prepared.next.managed,
      credential: original.credential,
    })
    expect(cold.get("raya.secondBrain.control.catalog")).toEqual(
      catalog
        ? {
            ...catalog,
            catalog: { ...catalog.catalog, source: prepared.source, source_sha256: prepared.next.setup.source_sha256 },
          }
        : undefined,
    )
    expect(cold.get("raya.secondBrain.personalCapture")).toEqual(
      consent ? { ...consent, release: digest(prepared.next.setup.source_sha256) } : undefined,
    )
    expect((await publish(cold, prepared.receipt)).publication).toEqual(recovered.publication)
    if (failure === 11) {
      const inspected = await inspect(cold, prepared.receipt)
      expect(inspected.saved).toEqual(original)
      expect(inspected.publication).toEqual(recovered.publication)
      expect(inspected.indexConfirmed).toBe(false)
      expect(inspected.requestSettlement).toBe(false)
      const audit = `raya.secondBrain.runtimeUpgrade.${prepared.id}`
      await cold.update(audit, { ...recovered.publication, phase: "prepared" })
      await expect(inspect(cold, prepared.receipt)).rejects.toThrow(
        "Applied runtime publication and cleared startup fence required",
      )
      await cold.update(audit, recovered.publication)
      await cold.update(audit, {
        ...recovered.publication,
        next: [
          {
            present: true,
            value: { ...original, credential: "raya.secondBrain.key.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
          },
          ...recovered.publication.next.slice(1),
        ],
      })
      await expect(inspect(cold, prepared.receipt)).rejects.toThrow("Retained runtime upgrade publication differs")
      await cold.update(audit, recovered.publication)
    }
  }
}, 180000)

test("materialize refuses a changed original file before creating replacement code", async () => {
  await writeFile(path.join(cfg.root, "source/memory/server.py"), "# changed synthetic original")
  await expect(materialize(cfg, setup, path.resolve("."), "c".repeat(32))).rejects.toThrow()
  expect(
    await stat(path.join(cfg.root, "raya-memory-source-upgrade-" + "c".repeat(32))).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
}, 30000)
