import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { z } from "zod"
import { fixture } from "./media-provision"
import { check, sha } from "../../../src/second-brain/control/frames"
import { image, directory } from "../../../src/second-brain/control/identity"
import { parse } from "../../../src/second-brain/managed/value"
import { sources, dependencies, current } from "../../../src/second-brain/media/catalog"
import { command } from "../../../src/second-brain/control/command"
import { fingerprint } from "../../../src/second-brain/failed-repair"

const original =
  "D:/Raya/Services/Memory/Managed/raya-memory-managed-f9483d7cba6a4fb4be2a35b22219903e/diagnostics/retrieval-service-admitted-v2.json"
const digest = "f927921e90c5078522a36e1a2949a40266c641072b36e8dd7d9f1ef6ccc58c2c"
const ref = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative().max(2147483648),

    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough()

/** Prior-admitted PyAV decoder qualification only; this does not qualify the current selected runtime or inference. */
export async function video() {
  const owned = await fixture({ contained: true })
  return (async () => {
    const cfg = await owned.selected()
    const held = await image(original, 16777216)
    check(held.digest === digest, "Exact approved Retrieval inventory required")
    const plan = z
      .object({ dependencies: z.string(), files: z.array(ref) })
      .passthrough()
      .parse(parse(held.raw))
    const rows = plan.files.filter((row) => {
      const name = path.relative(plan.dependencies, row.path).replaceAll("\\", "/")
      return /^(av\/|av\.libs\/|av-16\.0\.1\.dist-info\/)/.test(name)
    })
    check(
      rows.length === 256 &&
        rows.every((row) => row.bytes <= 33554432) &&
        rows.some((row) => /[\\/]av[\\/]_core\.cp312-win_amd64\.pyd$/.test(row.path)),
      "Exact approved PyAV subset required",
    )
    const identities = await command(
      cfg.python.path,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `import json, pathlib, sys
p=json.loads(pathlib.Path(sys.argv[1]).read_text())
rows=[r for r in p['files'] if pathlib.Path(r['path']).is_relative_to(p['dependencies']) and pathlib.Path(r['path']).relative_to(p['dependencies']).parts[0] in ('av','av.libs','av-16.0.1.dist-info')]
assert len(rows)==256
for r in rows:
 s=pathlib.Path(r['path']).lstat()
 assert [getattr(s,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_nlink')]==r['identity']
print('retained-pyav-identities-exact')`,
        original,
      ],
      { windowsHide: true },
    )
    check(
      identities.stdout.trim() === "retained-pyav-identities-exact" && identities.stderr === "",
      "Retained PyAV identities differ",
    )
    const deps = path.join(owned.root, "video-dependencies")
    await mkdir(deps)
    const files = []
    const retained = []
    for (const row of rows) {
      await directory(path.dirname(row.path))
      const before = await image(row.path, row.bytes)
      check(before.digest === row.sha256 && before.raw.length === row.bytes, "Approved PyAV image changed")
      const relative = path.relative(plan.dependencies, row.path)
      check(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Approved PyAV path escapes its root")
      const target = path.join(deps, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, before.raw, { flag: "wx" })
      const copied = await image(target, row.bytes)
      check(copied.digest === row.sha256 && copied.raw.length === row.bytes, "Owned PyAV copy differs")
      files.push({ path: relative.replaceAll("\\", "/"), bytes: row.bytes, sha256: row.sha256 })
      retained.push({ ...row, tuple: before.tuple })
    }
    const inventory = path.join(owned.root, "video-inventory.json")
    const raw = Buffer.from(JSON.stringify({ format: "raya.media.dependencies.v1", root: deps, files }))
    await writeFile(inventory, raw, { flag: "wx" })
    const model = path.join(owned.root, "catalog", "google--embeddinggemma-2.json")
    const manifest = await image(model, 16777216)
    const runtime = await dependencies({
      format: "raya.media.runtime.v1",
      python: cfg.python,
      dependencies: deps,
      inventory: { path: inventory, bytes: raw.length, sha256: sha(raw) },
      model: { path: model, bytes: manifest.raw.length, sha256: manifest.digest },
    })
    const source = path.join(owned.root, "personal")
    const project = path.join(owned.root, "workspace")
    const root = path.join(owned.root, "library")
    await Promise.all([source, project, root].map((dir) => mkdir(dir)))
    const file = path.join(source, "approved.mp4")
    const created = await command(
      cfg.python.path,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `import sys
from fractions import Fraction
sys.path.insert(0,sys.argv[1])
import av
with av.open(sys.argv[2],mode='w') as value:
 stream=value.add_stream('mpeg4',rate=2)
 stream.width=stream.height=64
 stream.pix_fmt='yuv420p'
 for index in range(4):
  frame=av.VideoFrame(64,64,'yuv420p')
  for plane in frame.planes:
   plane.update(bytes(plane.buffer_size))
  frame.pts=index
  frame.time_base=Fraction(1,2)
  for packet in stream.encode(frame):
   value.mux(packet)
 for packet in stream.encode():
  value.mux(packet)
assert not any(name in sys.modules for name in ('torch','transformers','encoder','sentence_transformers'))
print('actual-video-2s-no-model')`,
        deps,
        file,
      ],
      { windowsHide: true },
    )
    check(
      created.stdout.trim() === "actual-video-2s-no-model" && created.stderr === "",
      "Actual video fixture creation failed",
    )
    const bytes = (await image(file, 33554432)).raw
    const authorize = async () => {
      check((await image(original, 16777216)).tuple === held.tuple, "Original approved inventory changed")
      for (const row of retained) {
        const value = await image(row.path, row.bytes)
        check(value.tuple === row.tuple && value.digest === row.sha256, "Original approved PyAV subset changed")
      }
      await current(runtime)
    }
    await authorize()
    const packaged = await sources(path.resolve(import.meta.dir, "../../.."))
    const witness = {
      inventory: { path: original, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple },
      files: retained,
    }
    await writeFile(path.join(owned.root, "video-subset-witness.json"), JSON.stringify(witness), { flag: "wx" })
    return {
      owned,
      cfg,
      deps,
      root,
      source,
      project,
      file,
      bytes,
      authorize,
      sources: packaged.sources,
      release: fingerprint({ sources: packaged.release, runtime: runtime.release }),
      witness,
      created,
      identities,
    }
  })().catch(async (err: unknown) => {
    await owned.cleanup()
    throw err
  })
}
