import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, copyFile, link } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { select, verify as source } from "../../src/second-brain/media/selection"
import { parse, verify } from "../../src/second-brain/media/results"
import { sha } from "../../src/second-brain/control/frames"

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-media-source-"))
  const root = path.join(dir, "root")
  const library = path.join(dir, "library")
  await mkdir(root)
  await mkdir(library)
  const file = path.join(root, "selected.png")
  await writeFile(file, png)
  const selected = await select(root, file)
  const snapshot = path.join(library, selected.id + ".png")
  await copyFile(file, snapshot)
  const authorized = [
    {
      id: selected.id,
      path: file,
      relative: selected.relative,
      sha256: selected.sha256,
      bytes: selected.bytes,
      kind: selected.kind,
      snapshot: { path: snapshot, sha256: selected.sha256, bytes: selected.bytes },
      duration_ms: null,
    },
  ]
  const result = {
    action: "mediaContext",
    project: root,
    query_sha256: sha("query"),
    selection: {
      root,
      policy_sha256: "a".repeat(64),
      release_sha256: "b".repeat(64),
      generation: "c".repeat(32),
      authorized,
    },
    candidates: [
      {
        source: {
          id: selected.id,
          path: file,
          relative: selected.relative,
          sha256: selected.sha256,
          kind: selected.kind,
        },
        span: null,
        verdict: "uncertain",
        evidence: [],
        verifier: null,
        provenance: "User-selected immutable image; no verified subject claim",
        query_sha256: sha("query"),
        policy_sha256: "a".repeat(64),
      },
    ],
    truncated: false,
    capture_enabled: false,
  }
  const opts = {
    project: root,
    root,
    querySHA: sha("query"),
    policySHA: "a".repeat(64),
    releaseSHA: "b".repeat(64),
    generation: "c".repeat(32),
    selected: [selected],
    authorized,
    forgotten: [],
    library,
  }
  const cleanup = async () => {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()))
    expect(path.basename(dir).startsWith("raya-media-source-")).toBe(true)
    await rm(dir, { recursive: true })
  }
  return { dir, root, file, library, selected, snapshot, result, opts, cleanup }
}

test("only explicit immutable selection survives fresh consumption and uncertainty is preserved", async () => {
  const f = await fixture()
  try {
    expect(await source(f.root, f.selected)).toEqual(f.selected)
    expect((await verify(f.result, f.opts)).candidates[0].verdict).toBe("uncertain")
    await expect(verify(f.result, { ...f.opts, forgotten: [f.selected.id] })).rejects.toThrow("Forgotten")
    await expect(verify(f.result, { ...f.opts, generation: "d".repeat(32) })).rejects.toThrow("stale")
    await writeFile(f.snapshot, Buffer.concat([png, Buffer.from([1])]))
    await expect(verify(f.result, f.opts)).rejects.toThrow("snapshot changed")
  } finally {
    await f.cleanup()
  }
})

test("source mutations, links, restrictions, ignore edits and root escape require a new review", async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.root, ".rayaignore"), "selected.png\n")
    await expect(select(f.root, f.file)).rejects.toThrow("excluded")
    await rm(path.join(f.root, ".rayaignore"))
    await writeFile(f.file, Buffer.concat([png, Buffer.from([2])]))
    await expect(source(f.root, f.selected)).rejects.toThrow("changed")
    await link(f.file, path.join(f.root, "hardlink.png"))
    await expect(select(f.root, f.file)).rejects.toThrow("single-link")
    await mkdir(path.join(f.root, "Private"))
    await writeFile(path.join(f.root, "Private", "photo.png"), png)
    await expect(select(f.root, path.join(f.root, "Private", "photo.png"))).rejects.toThrow("Restricted")
    await expect(select(f.root, path.join(f.dir, "outside.png"))).rejects.toThrow("escapes")
  } finally {
    await f.cleanup()
  }
})

test("ranked results cannot fabricate verifier support or decoded temporal evidence", async () => {
  const f = await fixture()
  try {
    const candidate = f.result.candidates[0]
    expect(() => parse({ ...f.result, candidates: [{ ...candidate, score: 1 }] })).toThrow()
    expect(() => parse({ ...f.result, candidates: [{ ...candidate, verdict: "supported" }] })).toThrow("verifier")
    const supported = {
      ...f.result,
      candidates: [
        {
          ...candidate,
          verdict: "supported",
          evidence: [{ text: "Observed pixel", sha256: sha("Observed pixel"), span: null }],
          verifier: { id: "invented", sha256: "e".repeat(64) },
        },
      ],
    }
    await expect(verify(supported, f.opts)).rejects.toThrow("selected verified release")
    const audio = {
      ...f.result,
      selection: {
        ...f.result.selection,
        authorized: f.result.selection.authorized.map((item) => ({ ...item, kind: "audio", duration_ms: 1000.5 })),
      },
      candidates: [
        { ...candidate, source: { ...candidate.source, kind: "audio" }, span: { start_ms: 0.25, end_ms: 1000.5 } },
      ],
    }
    expect(parse(audio).candidates[0].span?.start_ms).toBe(0.25)
    expect(() =>
      parse({ ...audio, candidates: [{ ...audio.candidates[0], span: { start_ms: 0, end_ms: 1001 } }] }),
    ).toThrow("decoded")
  } finally {
    await f.cleanup()
  }
})

test("timed candidates require independently retained decoded ranges and exact duration metadata", async () => {
  const f = await fixture()
  try {
    const file = path.join(f.root, "selected.wav")
    const wav = Buffer.alloc(32044)
    wav.write("RIFF", 0)
    wav.writeUInt32LE(32036, 4)
    wav.write("WAVEfmt ", 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24)
    wav.writeUInt32LE(32000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write("data", 36)
    wav.writeUInt32LE(32000, 40)
    await writeFile(file, wav)
    const selected = await select(f.root, file)
    const snapshot = path.join(f.library, selected.id + ".wav")
    await copyFile(file, snapshot)
    const authorized = [
      {
        id: selected.id,
        path: file,
        relative: selected.relative,
        sha256: selected.sha256,
        bytes: selected.bytes,
        kind: selected.kind,
        snapshot: { path: snapshot, sha256: selected.sha256, bytes: selected.bytes },
        duration_ms: 1000,
      },
    ]
    const candidate = {
      ...f.result.candidates[0],
      source: {
        id: selected.id,
        path: file,
        relative: selected.relative,
        sha256: selected.sha256,
        kind: selected.kind,
      },
      span: { start_ms: 200.25, end_ms: 800.5 },
    }
    const result = { ...f.result, selection: { ...f.result.selection, authorized }, candidates: [candidate] }
    const opts = { ...f.opts, selected: [selected], authorized }
    await expect(verify(result, opts)).rejects.toThrow("actual decoded candidate range")
    await expect(
      verify(result, { ...opts, segments: [{ id: selected.id, start_ms: 300, end_ms: 800.5 }] }),
    ).rejects.toThrow("actual decoded candidate range")
    expect(
      (await verify(result, { ...opts, segments: [{ id: selected.id, start_ms: 200.25, end_ms: 800.5 }] }))
        .candidates[0].span,
    ).toEqual(candidate.span)
    await expect(
      verify(result, { ...opts, authorized: authorized.map((item) => ({ ...item, duration_ms: 900 })) }),
    ).rejects.toThrow("Exact authorized")
  } finally {
    await f.cleanup()
  }
})
