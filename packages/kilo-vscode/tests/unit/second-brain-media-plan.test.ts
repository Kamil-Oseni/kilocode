import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { prepare, verify, policy } from "../../src/second-brain/media/plan"
import { exec } from "../../src/util/process"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8O8AAAAASUVORK5CYII=",
  "base64",
)
const signal = () => new AbortController().signal

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-media-plan-"))
  const project = path.join(dir, "workspace")
  const source = path.join(dir, "photos-é")
  const root = path.join(dir, "library")
  await Promise.all([project, source, root].map((folder) => mkdir(folder)))
  const image = path.join(source, "café-😀.png")
  const audio = path.join(source, "voice-é.wav")
  const wav = Buffer.alloc(46)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(38, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(2, 40)
  await Promise.all([writeFile(image, png), writeFile(audio, wav)])
  const cfg = { project, source, root, files: [image, audio], excluded: [] as string[] }
  const cleanup = async () => {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()))
    expect(path.basename(dir).startsWith("raya-media-plan-")).toBe(true)
    await rm(dir, { recursive: true })
  }
  return { dir, project, source, root, image, audio, wav, cfg, cleanup }
}

test("explicit PNG and PCM files produce a review with original bindings and no consent", async () => {
  const f = await fixture()
  try {
    const review = await prepare(f.cfg, signal())
    expect(review.authority).toBe(false)
    expect(review.capture_enabled).toBe(false)
    expect(review.selection.files.map((file) => file.kind)).toEqual(["image", "audio"])
    expect(review.selection.files.map((file) => file.path)).toEqual(f.cfg.files)
    expect(review.selection.files.map((file) => file.title)).toEqual(["café-😀.png", "voice-é.wav"])
    expect(review.policySHA).toBe(policy(review.selection))
    expect(await verify(review, f.project, signal())).toBe(review)
  } finally {
    await f.cleanup()
  }
})

test("actual selections reject mismatched signatures, source escapes, private roots and exclusions", async () => {
  const f = await fixture()
  try {
    await writeFile(f.image, "invalid PNG")
    await expect(prepare(f.cfg, signal())).rejects.toThrow("PNG signature")
    await writeFile(f.image, png)
    await writeFile(f.audio, "invalid WAV")
    await expect(prepare(f.cfg, signal())).rejects.toThrow("WAV signature")
    await writeFile(f.audio, f.wav)
    const escaped = path.join(f.project, "escaped.png")
    await writeFile(escaped, png)
    await expect(prepare({ ...f.cfg, files: [escaped] }, signal())).rejects.toThrow("escapes")
    const privatefile = path.join(f.root, "private.png")
    await writeFile(privatefile, png)
    await expect(prepare({ ...f.cfg, files: [privatefile] }, signal())).rejects.toThrow("private library")
    await expect(prepare({ ...f.cfg, excluded: [f.source] }, signal())).rejects.toThrow("excluded root")
    await writeFile(path.join(f.source, ".rayaignore"), "*.png\n")
    await expect(prepare(f.cfg, signal())).rejects.toThrow("excluded by .rayaignore")
  } finally {
    await f.cleanup()
  }
})

test("duplicate paths, exclusion roots and original content cannot form a review", async () => {
  const f = await fixture()
  try {
    await expect(prepare({ ...f.cfg, files: [f.image, f.image] }, signal())).rejects.toThrow("Duplicate selected")
    await expect(prepare({ ...f.cfg, excluded: [f.project, f.project] }, signal())).rejects.toThrow(
      "Duplicate selected",
    )
    const copied = path.join(f.source, "copied.png")
    await copyFile(f.image, copied)
    await expect(prepare({ ...f.cfg, files: [f.image, copied] }, signal())).rejects.toThrow(
      "Duplicate selected media content",
    )
    const review = await prepare(f.cfg, signal())
    review.selection.excluded = [f.project, f.project]
    review.policySHA = policy(review.selection)
    await expect(verify(review, f.project, signal())).rejects.toThrow("distinct reviewed")
  } finally {
    await f.cleanup()
  }
})

test("fresh review consumption refuses changed original bytes and changed ignore receipts", async () => {
  const f = await fixture()
  try {
    const review = await prepare(f.cfg, signal())
    await writeFile(f.image, Buffer.concat([png, Buffer.from("changed")]))
    await expect(verify(review, f.project, signal())).rejects.toThrow("review again")
    await writeFile(f.image, png)
    await writeFile(path.join(f.source, ".rayaignore"), "# initial policy\n")
    const next = await prepare(f.cfg, signal())
    await writeFile(path.join(f.source, ".rayaignore"), "# changed policy\n")
    await expect(verify(next, f.project, signal())).rejects.toThrow("review again")
  } finally {
    await f.cleanup()
  }
})

test("changed review metadata and recomputed file policy never become authority", async () => {
  const f = await fixture()
  try {
    const review = await prepare(f.cfg, signal())
    await expect(verify(review, f.root, signal())).rejects.toThrow("another project")
    for (const patch of [
      { generation: "invalid" },
      { authority: true },
      { capture_enabled: true },
      { policySHA: "0".repeat(64) },
    ])
      await expect(verify({ ...review, ...patch } as typeof review, f.project, signal())).rejects.toThrow(
        "changed policy",
      )
    const changed = structuredClone(review)
    changed.selection.files[0].title = "invented title"
    changed.policySHA = policy(changed.selection)
    await expect(verify(changed, f.project, signal())).rejects.toThrow("selected original")
    const format = structuredClone(review)
    Object.assign(format.selection, { format: "foreign.selection" })
    format.policySHA = policy(format.selection)
    await expect(verify(format, f.project, signal())).rejects.toThrow()
    expect(review.authority).toBe(false)
    expect(review.capture_enabled).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test("review preparation and consumption observe original cancellation", async () => {
  const f = await fixture()
  try {
    const review = await prepare(f.cfg, signal())
    const before = new AbortController()
    before.abort(new Error("original review cancelled"))
    await expect(prepare(f.cfg, before.signal)).rejects.toThrow("original review cancelled")
    await expect(verify(review, f.project, before.signal)).rejects.toThrow("original review cancelled")
    const during = new AbortController()
    const pending = prepare(f.cfg, during.signal)
    queueMicrotask(() => during.abort(new Error("review cancelled during inspection")))
    await expect(pending).rejects.toThrow("review cancelled during inspection")
  } finally {
    await f.cleanup()
  }
})

const native = process.platform === "win32" ? test : test.skip
native(
  "UTF-8 review policy matches actual contained Python encoding for non-ASCII paths and titles",
  async () => {
    const f = await fixture()
    try {
      const review = await prepare(f.cfg, signal())
      const code =
        "import base64,hashlib,json,sys;sys.path.insert(0,sys.argv[1]);from session import encode;print(hashlib.sha256(encode(json.loads(base64.b64decode(sys.argv[2])))).hexdigest());assert 'torch' not in sys.modules and 'encoder' not in sys.modules"
      const result = await exec(
        "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          code,
          path.resolve(import.meta.dir, "../../script/memory/media"),
          Buffer.from(JSON.stringify(review.selection)).toString("base64"),
        ],
        { maxBuffer: 65536 },
      )
      expect(result.stderr).toBe("")
      expect(result.stdout.trim()).toBe(review.policySHA)
    } finally {
      await f.cleanup()
    }
  },
  30_000,
)
