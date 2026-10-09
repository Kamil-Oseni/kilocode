import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { MediaCoordinator } from "../../src/second-brain/media/coordinator"
import { document, object, sha } from "../../src/second-brain/control/frames"
import { normalize } from "../../src/second-brain/control/identity"
import { publish } from "../../src/second-brain/managed/owner"
import { fixture } from "./fixtures/media-provision"
import { select } from "../../src/second-brain/media/selection"

async function setup(malformed = false) {
  const owned = await fixture({ contained: true })
  const cfg = await owned.selected()
  const source = path.join(owned.root, "personal")
  const project = path.join(owned.root, "workspace")
  await mkdir(source)
  await mkdir(project)
  const bytes = Buffer.alloc(32044)
  bytes.write("RIFF", 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36)
  bytes.writeUInt32LE(32000, 40)
  if (malformed) bytes.writeUInt16LE(65535, 20)
  const file = path.join(source, "approved.wav")
  await writeFile(file, bytes, { flag: "wx" })
  const values = new Map<string, unknown>()
  const control = { refuse: false, writes: 0 }
  const store = {
    get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined
    },
    async update(key: string, value: unknown) {
      control.writes++
      values.set(key, structuredClone(value))
      if (control.refuse) throw new Error("Actual applied storage acknowledgement lost")
    },
  }
  const opts = {
    extension: path.resolve(import.meta.dir, "../.."),
    storage: owned.root,
    store,
    trusted: (value: string) => {
      if (value !== project) throw new Error("Wrong authenticated project")
    },
  }
  const coordinator = new MediaCoordinator(opts)
  const signal = new AbortController().signal
  const draft = await coordinator.draft(project, { source, files: [file], excluded: [] }, cfg, signal)
  return { owned, project, source, file, bytes, store, values, control, opts, coordinator, signal, draft }
}

test("native media consent and actual pure workers preserve originals and certify inspect/import/forget", async () => {
  const f = await setup()
  try {
    expect(f.control.writes).toBe(0)
    expect(f.draft.review.authority).toBe(false)
    const grant = await f.coordinator.approve(f.draft, f.signal)
    expect(grant.review).toEqual(f.draft.review)
    const id = f.draft.review.files[0].id
    for (const op of ["inspect", "import", "forget"] as const) {
      const result = await f.coordinator[op](f.project, id, f.signal)
      expect(result).toHaveProperty("op", op)
      const saved = await f.coordinator.grant(f.project, f.signal)
      expect(saved.state.operations.at(-1)?.op).toBe(op)
      expect(f.coordinator.active()).toEqual([])
      expect(await readdir(path.join(saved.metadata, "Claims"))).not.toContain(sha(normalize(f.project)) + ".json")
    }
    expect(await readFile(f.file)).toEqual(f.bytes)
    expect(f.control.writes).toBe(4)
    await expect(f.coordinator.context(f.project, "A possible audio match", 1, f.signal)).rejects.toThrow(
      "index evidence",
    )
    await f.coordinator.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 90000)

test("applied consent acknowledgement loss cannot become cold native media authority", async () => {
  const f = await setup()
  try {
    f.control.refuse = true
    await expect(f.coordinator.approve(f.draft, f.signal)).rejects.toThrow("acknowledgement lost")
    expect(f.values.size).toBe(1)
    const cold = new MediaCoordinator(f.opts)
    await expect(cold.grant(f.project, f.signal)).rejects.toThrow()
    await expect(cold.import(f.project, f.draft.review.files[0].id, f.signal)).rejects.toThrow()
    expect(await readdir(path.join(f.draft.metadata, "Claims"))).toEqual([])
    expect(await readFile(f.file)).toEqual(f.bytes)
    expect(f.control.writes).toBe(1)
    await cold.retire()
    await f.coordinator.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 30000)

test("cold retained exclusive media claim forbids automatic replay without changing its bytes", async () => {
  const f = await setup()
  try {
    const grant = await f.coordinator.approve(f.draft, f.signal)
    const claim = await publish(path.join(f.draft.metadata, "Claims", sha(normalize(f.project)) + ".json"), {
      format: "raya.media.claim.v1",
      grant: grant.grant,
      request: { request: "a".repeat(32), epoch: "b".repeat(32) },
    })
    const before = await readFile(claim.path)
    const cold = new MediaCoordinator(f.opts)
    await expect(cold.inspect(f.project, f.draft.review.files[0].id, f.signal)).rejects.toThrow("unresolved")
    expect(await readFile(claim.path)).toEqual(before)
    expect(f.control.writes).toBe(1)
    expect(await readdir(path.join(f.draft.review.selection.root, "Runs"))).toEqual([])
    await cold.retire()
    await f.coordinator.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 30000)

test("changed native review and mismatched cancellation never publish media authority", async () => {
  const f = await setup()
  try {
    await expect(
      f.coordinator.cancel({ project: f.project, request: "a".repeat(32), epoch: "b".repeat(32), op: "import" }),
    ).rejects.toThrow("Exact original")
    await writeFile(f.file, Buffer.concat([f.bytes, Buffer.from("changed")]))
    await expect(f.coordinator.approve(f.draft, f.signal)).rejects.toThrow()
    expect(f.values.size).toBe(0)
    expect(f.control.writes).toBe(0)
    expect(await readdir(path.join(f.draft.metadata, "Claims"))).toEqual([])
    await f.coordinator.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 30000)

test("actual failed decoder retains its exclusive claim across reopen and retirement", async () => {
  const f = await setup(true)
  try {
    await f.coordinator.approve(f.draft, f.signal)
    const id = f.draft.review.files[0].id
    await expect(f.coordinator.inspect(f.project, id, f.signal)).rejects.toBeInstanceOf(AggregateError)
    const file = path.join(f.draft.metadata, "Claims", sha(normalize(f.project)) + ".json")
    const before = await readFile(file)
    const cold = new MediaCoordinator(f.opts)
    await expect(cold.inspect(f.project, id, f.signal)).rejects.toThrow("unresolved")
    expect(await readFile(file)).toEqual(before)
    expect(await readFile(f.file)).toEqual(f.bytes)
    await expect(f.coordinator.retire()).rejects.toThrow("uncertain")
    await cold.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 60000)

for (const suffix of ["pending", "terminal"]) {
  test(`cold media authority rejects changed original ${suffix} evidence despite a retained joined receipt`, async () => {
    const f = await setup()
    try {
      await f.coordinator.approve(f.draft, f.signal)
      await f.coordinator.inspect(f.project, f.draft.review.files[0].id, f.signal)
      const grant = await f.coordinator.grant(f.project, f.signal)
      const op = grant.state.operations[0]
      const proof = object(document(await readFile(op.receipt.path)).value)
      const request = object(proof.request)
      const file = path.join(
        grant.review.selection.root,
        "Requests",
        String(request.epoch),
        op.request + `.${suffix}.json`,
      )
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(" ")]))
      const cold = new MediaCoordinator(f.opts)
      await expect(cold.grant(f.project, f.signal)).rejects.toThrow("evidence changed")
      expect(f.control.writes).toBe(2)
      expect(await readFile(f.file)).toEqual(f.bytes)
      await f.coordinator.retire()
      await cold.retire()
    } finally {
      await f.owned.cleanup()
    }
  }, 30000)
}

test("changed selected dependency code cannot start a pure media worker", async () => {
  const f = await setup()
  try {
    await f.coordinator.approve(f.draft, f.signal)
    await writeFile(f.owned.pyc, Buffer.from("unselected dependency code"))
    await expect(f.coordinator.inspect(f.project, f.draft.review.files[0].id, f.signal)).rejects.toThrow("runtime")
    expect(f.control.writes).toBe(1)
    expect(await readdir(path.join(f.draft.review.selection.root, "Runs"))).toEqual([])
    expect(await readdir(path.join(f.draft.metadata, "Claims"))).toEqual([])
    expect(await readFile(f.file)).toEqual(f.bytes)
    await f.coordinator.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 30000)

test("native JPEG result guard accepts the worker's canonical jpg snapshot and rejects a jpeg alias", async () => {
  const f = await setup()
  try {
    // The stdlib fixture has no Pillow: exercise the actual provenance guard without claiming decoder qualification.
    const bytes = Buffer.from([255, 216, 255, 217])
    const file = path.join(f.source, "attachment.jpeg")
    await writeFile(file, bytes, { flag: "wx" })
    const selected = await select(f.source, file)
    const root = f.draft.review.selection.root
    await mkdir(path.join(root, "Assets"))
    const target = path.join(root, "Assets", selected.id + ".jpg")
    await writeFile(target, bytes, { flag: "wx" })
    const outcome: unknown = Reflect.get(f.coordinator, "outcome")
    if (typeof outcome !== "function") throw new Error("Production media outcome guard required")
    const value = {
      origin: selected.path,
      sourceSHA: selected.sha256,
      decoded: { sha256: selected.sha256 },
      id: selected.id,
      kind: selected.kind,
      bytes: selected.bytes,
      imported: true,
      indexed: false,
      snapshot: { path: target, sha256: selected.sha256, bytes: selected.bytes },
    }
    await expect(
      Reflect.apply(outcome, f.coordinator, [selected, { op: "import" }, { root }, value]),
    ).resolves.toBeUndefined()
    await expect(
      Reflect.apply(outcome, f.coordinator, [
        selected,
        { op: "import" },
        { root },
        { ...value, snapshot: { ...value.snapshot, path: target.replace(/\.jpg$/, ".jpeg") } },
      ]),
    ).rejects.toThrow("exact original content address")
    expect(await readFile(file)).toEqual(bytes)
    expect(f.control.writes).toBe(0)
    await f.coordinator.retire()
  } finally {
    await f.owned.cleanup()
  }
}, 30000)

for (const field of ["release", "policySHA"] as const) {
  test(`cold media history rejects a foreign terminal ${field} on an actual joined worker proof`, async () => {
    const f = await setup()
    try {
      await f.coordinator.approve(f.draft, f.signal)
      await f.coordinator.inspect(f.project, f.draft.review.files[0].id, f.signal)
      const grant = await f.coordinator.grant(f.project, f.signal)
      const op = grant.state.operations[0]
      const proof = object(document(await readFile(op.receipt.path)).value)
      const forged = await publish(path.join(grant.metadata, "Requests", op.request + ".foreign.json"), {
        ...proof,
        terminal: { ...object(proof.terminal), [field]: "f".repeat(64) },
      })
      const key = "raya.media.grant." + sha(normalize(f.project))
      await f.store.update(key, { ...grant.state, operations: [{ ...op, receipt: forged }] })
      const cold = new MediaCoordinator(f.opts)
      await expect(cold.grant(f.project, f.signal)).rejects.toThrow("Original completed media operation required")
      expect(await readFile(f.file)).toEqual(f.bytes)
      await f.coordinator.retire()
      await cold.retire()
    } finally {
      await f.owned.cleanup()
    }
  }, 30000)
}
