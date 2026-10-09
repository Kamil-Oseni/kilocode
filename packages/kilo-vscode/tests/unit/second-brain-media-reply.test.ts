import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { build } from "../../src/second-brain/media/reply"
import { prepare, policy } from "../../src/second-brain/media/plan"
import { verify } from "../../src/second-brain/media/results"
import { run, type Launch, type Request } from "../../src/second-brain/media/transport"
import { sha } from "../../src/second-brain/control/frames"

const extension = path.resolve(import.meta.dir, "../..")
const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
const native =
  process.platform === "win32" && existsSync(python) && existsSync(path.join(extension, "bin/raya-process-host.exe"))
    ? test
    : test.skip
const id = () => randomUUID().replaceAll("-", "")

async function ref(file: string) {
  const raw = await readFile(file)
  return { path: file, bytes: raw.length, sha256: sha(raw) }
}

native(
  "reply projects actual owned WAV import metadata; search envelopes test contracts without inference",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "raya-media-reply-"))
    const project = path.join(dir, "workspace")
    const source = path.join(dir, "selected")
    const root = path.join(dir, "library")
    const dependencies = path.join(dir, "dependencies")
    await Promise.all([project, source, root, dependencies].map((dir) => mkdir(dir)))
    const raw = Buffer.alloc(44 + 1969 * 2)
    raw.write("RIFF")
    raw.writeUInt32LE(raw.length - 8, 4)
    raw.write("WAVEfmt ", 8)
    raw.writeUInt32LE(16, 16)
    raw.writeUInt16LE(1, 20)
    raw.writeUInt16LE(1, 22)
    raw.writeUInt32LE(16000, 24)
    raw.writeUInt32LE(32000, 28)
    raw.writeUInt16LE(2, 32)
    raw.writeUInt16LE(16, 34)
    raw.write("data", 36)
    raw.writeUInt32LE(raw.length - 44, 40)
    const file = path.join(source, "approved.wav")
    await writeFile(file, raw, { flag: "wx" })
    const signal = new AbortController().signal
    const review = await prepare({ project, source, root, files: [file], excluded: [] }, signal)
    const media = path.join(extension, "script/memory/media")
    const cfg: Launch = {
      format: "raya.media.launch.v1",
      root,
      dependencies,
      python: await ref(python),
      sources: {
        "supervisor.py": await ref(path.join(media, "supervisor.py")),
        "worker.py": await ref(path.join(media, "worker.py")),
        "session.py": await ref(path.join(media, "session.py")),
        "library.py": await ref(path.join(media, "library.py")),
        "encoder.py": await ref(path.join(media, "encoder.py")),
        "owner.py": await ref(path.join(media, "../retrieval/owner.py")),
      },
    }
    const operation = (op: Request["op"]): Request => ({
      format: "raya.media.operation.v1",
      request: id(),
      epoch: id(),
      release: "a".repeat(64),
      policySHA: review.policySHA,
      op,
      selection: review.selection,
      args: { id: sha(raw) },
      model: null,
    })
    const original = operation("import")
    const imported = await run(
      extension,
      cfg,
      original,
      signal,
      async () => {},
      async () => {},
    )
    expect(imported.terminal.accepted).toBe(true)
    const pending = await readFile(path.join(root, "Requests", original.epoch, original.request + ".pending.json"))
    expect(imported.terminal.pendingSHA).toBe(sha(pending))
    expect(JSON.parse(pending.toString()).requestSHA).toBe(policy(original))
    expect(JSON.parse(pending.toString()).operation).toEqual(original)
    const receipt = JSON.parse(await readFile(imported.receipt.path, "utf8"))
    expect(receipt).toMatchObject({
      familyJoined: true,
      originalJoined: true,
      readersJoined: true,
      writerJoined: true,
      forced: false,
    })
    const binding = imported.terminal.result as Record<string, unknown>
    const inventory = Object.fromEntries(
      Object.entries(binding).filter(([key]) => !["imported", "indexed"].includes(key)),
    )
    const query = "What sound is in this selected attachment?"
    const request = { ...operation("search"), args: { query, top: 1 } }
    // The envelope is an adapter schema fixture. No search worker, encoder, or model is executed.
    const candidate = {
      ...inventory,
      start: 0,
      end: 1969 / 16000,
      verification: "uncertain",
      verifier: "unavailable",
      evidence: "A supervised source evidence verifier is required.",
      authority: false,
    }
    const terminal = {
      format: "raya.media.terminal.v1",
      request: request.request,
      epoch: request.epoch,
      release: request.release,
      policySHA: request.policySHA,
      pendingSHA: policy(request),
      op: "search",
      status: "completed",
      accepted: true,
      authority: false,
      replay: false,
      forced: false,
      result: { querySHA: sha(query), inventory: [inventory], candidates: [candidate], authority: false },
    }
    const reply = build(review, request, terminal, terminal.pendingSHA)
    expect(reply.value.candidates[0]).toMatchObject({
      verdict: "uncertain",
      verifier: null,
      evidence: [],
      span: { start_ms: 0, end_ms: 123.0625 },
    })
    expect(reply.authorized[0].duration_ms).toBe(123.0625)
    const opts = {
      project,
      root: source,
      querySHA: sha(query),
      policySHA: review.policySHA,
      releaseSHA: request.release,
      generation: review.generation,
      selected: review.files,
      authorized: reply.authorized,
      forgotten: [],
      library: root,
      segments: reply.segments,
    }
    expect(await verify(reply.value, opts)).toEqual(reply.value)
    const reject = (value: unknown) => expect(() => build(review, request, value, terminal.pendingSHA)).toThrow()
    for (const patch of [
      { request: id() },
      { epoch: id() },
      { release: "b".repeat(64) },
      { policySHA: "b".repeat(64) },
      { pendingSHA: "b".repeat(64) },
      { accepted: false },
      { forced: true },
      { status: "failed" },
    ])
      reject({ ...terminal, ...patch })
    for (const patch of [
      { querySHA: "b".repeat(64) },
      { inventory: [inventory, inventory] },
      { candidates: [candidate, candidate] },
    ])
      reject({ ...terminal, result: { ...terminal.result, ...patch } })
    for (const patch of [
      { origin: path.join(source, "other.wav") },
      { sourceSHA: "b".repeat(64) },
      { start: 0.0001 },
      { end: Infinity },
      { verification: "supported" },
      { verifier: "pretend" },
      { similarity: 1 },
    ])
      reject({ ...terminal, result: { ...terminal.result, candidates: [{ ...candidate, ...patch }] } })
    expect(() =>
      build(
        review,
        { ...request, args: { query, top: 2 } },
        { ...terminal, result: { ...terminal.result, candidates: [candidate, candidate] } },
        terminal.pendingSHA,
      ),
    ).toThrow("Duplicate media candidate")
    const decoded = inventory.decoded as Record<string, unknown>
    for (const patch of [
      { duration: 61 },
      { segments: [{ start: 0, end: 1 }] },
      {
        segments: [
          { start: 0, end: 0.1 },
          { start: 0.05, end: 1969 / 16000 },
        ],
      },
      { bytes: raw.length + 1 },
    ]) {
      const changed = { ...inventory, decoded: { ...decoded, ...patch } }
      reject({
        ...terminal,
        result: { ...terminal.result, inventory: [changed], candidates: [{ ...candidate, ...changed }] },
      })
    }
    for (const target of [path.join(root, "../escape.wav"), path.join(root, "Assets", "b".repeat(64) + ".wav")]) {
      const changed = { ...inventory, snapshot: { ...reply.authorized[0].snapshot, path: target } }
      reject({
        ...terminal,
        result: { ...terminal.result, inventory: [changed], candidates: [{ ...candidate, ...changed }] },
      })
    }
    await expect(verify(reply.value, { ...opts, generation: id() })).rejects.toThrow()
    await expect(verify(reply.value, { ...opts, forgotten: [sha(raw)] })).rejects.toThrow()
    await writeFile(file, Buffer.concat([raw, Buffer.from([0])]))
    await expect(verify(reply.value, opts)).rejects.toThrow()
    await writeFile(file, raw)
    await writeFile(reply.authorized[0].snapshot.path, Buffer.concat([raw, Buffer.from([0])]))
    await expect(verify(reply.value, opts)).rejects.toThrow()
    await writeFile(reply.authorized[0].snapshot.path, raw)
    const forgotten = await run(
      extension,
      cfg,
      operation("forget"),
      signal,
      async () => {},
      async () => {},
    )
    expect(forgotten.terminal.accepted).toBe(true)
    expect(await readFile(file)).toEqual(raw)
  },
  60000,
)
