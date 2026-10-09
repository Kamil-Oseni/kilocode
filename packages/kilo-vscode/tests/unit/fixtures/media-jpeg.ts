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
  "D:/Raya/Services/Memory/Managed/raya-memory-managed-45b36f49c36b4a9d880266dffe59d43c/raya-memory-fresh-ac35addaa11c48fb8fcf06a98ea9b962/memory/Runs/8f202e6dfd04b0f8c5153a931276ff58/retrieval-plan.json"
const digest = "50610137148205ddf67246e2e8377d04169650be50651ac47d5d387114090f60"
const ref = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative().max(2147483648),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough()

/** Copy only the existing approved Pillow distribution; all process and media effects stay in the owned fixture. */
export async function jpeg() {
  const owned = await fixture({ contained: true })
  const cfg = await owned.selected()
  const held = await image(original, 16777216)
  check(held.digest === digest, "Exact approved Retrieval inventory required")
  const plan = z
    .object({ dependencies: z.string(), files: z.array(ref) })
    .passthrough()
    .parse(parse(held.raw))
  const rows = plan.files.filter((row) => {
    const name = path.relative(plan.dependencies, row.path).replaceAll("\\", "/")
    return /^(PIL\/|pillow\.libs\/|pillow-[^/]+\.dist-info\/)/.test(name)
  })
  check(
    rows.length === 122 &&
      rows.every((row) => row.bytes <= 16777216) &&
      rows.some((row) => /[\\/]PIL[\\/]_imaging\.cp312-win_amd64\.pyd$/.test(row.path)),
    "Exact approved Pillow subset required",
  )
  const deps = path.join(owned.root, "jpeg-dependencies")
  await mkdir(deps)
  const files = []
  const retained = []
  for (const row of rows) {
    await directory(path.dirname(row.path))
    const before = await image(row.path, row.bytes)
    check(before.digest === row.sha256 && before.raw.length === row.bytes, "Approved Pillow image changed")
    const relative = path.relative(plan.dependencies, row.path)
    check(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Approved Pillow path escapes its root")
    const target = path.join(deps, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, before.raw, { flag: "wx" })
    const copied = await image(target, row.bytes)
    check(copied.digest === row.sha256 && copied.raw.length === row.bytes, "Owned Pillow copy differs")
    files.push({ path: relative.replaceAll("\\", "/"), bytes: row.bytes, sha256: row.sha256 })
    retained.push({ ...row, tuple: before.tuple })
  }
  const inventory = path.join(owned.root, "jpeg-inventory.json")
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
  const file = path.join(source, "approved.jpeg")
  const created = await command(
    cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `import sys
sys.path.insert(0,sys.argv[1])
from PIL import Image
Image.new('RGB',(3,2),(210,30,40)).save(sys.argv[2],format='JPEG')
with Image.open(sys.argv[2]) as value:
 value.load()
 assert value.size==(3,2) and value.format=='JPEG'
assert not any(name in sys.modules for name in ('torch','transformers','encoder'))
print('actual-jpeg-3x2-no-model')`,
      deps,
      file,
    ],
    { windowsHide: true },
  )
  check(
    created.stdout.trim() === "actual-jpeg-3x2-no-model" && created.stderr === "",
    "Actual JPEG fixture creation failed",
  )
  const bytes = (await image(file, 33554432)).raw
  const authorize = async () => {
    check((await image(original, 16777216)).tuple === held.tuple, "Original approved inventory changed")
    for (const row of retained) {
      const value = await image(row.path, row.bytes)
      check(value.tuple === row.tuple && value.digest === row.sha256, "Original approved Pillow subset changed")
    }
    await current(runtime)
  }
  await authorize()
  const packaged = await sources(path.resolve(import.meta.dir, "../../.."))
  const witness = {
    inventory: { path: original, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple },
    files: retained,
  }
  await writeFile(path.join(owned.root, "jpeg-subset-witness.json"), JSON.stringify(witness), { flag: "wx" })
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
  }
}
