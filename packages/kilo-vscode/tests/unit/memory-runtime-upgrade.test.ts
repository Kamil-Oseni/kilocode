import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { release } from "../../src/second-brain/control/catalog-capture"
import { project } from "../../src/second-brain/managed/upgrade"

type Image = { path: string; bytes: number; sha256: string; identity: string[] }
type Fixture = { raw: string; rows: Image[]; directory: { path: string; identity: string[] } }
let root: string
let fixture: Fixture

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "raya-upgrade-test-"))
  await Promise.all([mkdir(path.join(root, "prior")), mkdir(path.join(root, "next"))])
  await Promise.all(
    Object.keys(release).map(async (name) => {
      const raw = await readFile(path.resolve("script/memory/service", name))
      await Promise.all([writeFile(path.join(root, "prior", name), raw), writeFile(path.join(root, "next", name), raw)])
    }),
  )
  await writeFile(path.join(root, "next", "supervise.py"), await readFile(path.resolve("script/memory/supervise.py")))
  const script = `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);pins=json.loads(sys.argv[2]);rows=[];files=[]
def image(file):
 info=file.lstat();raw=file.read_bytes();identity=[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink]
 return {'path':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'identity':identity}
for name in pins:
 files.append(image(root/'prior'/name));rows.append(image(root/'next'/name))
rows.append(image(root/'next'/'supervise.py'))
directories=[]
for directory in (root,root/'prior'):
 info=directory.lstat();directories.append({'path':str(directory),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]})
info=(root/'next').lstat();directory={'path':str(root/'next'),'identity':[str(info.st_dev),str(info.st_ino),str(info.st_ctime_ns)]}
plan={'format':'raya.memory.managed.supervisor','version':1,'kind':'memory','root':str(root),'source':str(root/'prior'),'source_sha256':pins,'files':files,'directories':directories,'retained':{'identity':[18446744073709551615,1791503155482873601]}}
for row in rows: row['identity']=[str(value) for value in row['identity']]
print(json.dumps({'raw':json.dumps(plan,separators=(',',':')),'rows':rows,'directory':directory}))`
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      "-I",
      "-S",
      "-B",
      "-c",
      script,
      root,
      JSON.stringify(release),
    ],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  expect(error).toBe("")
  fixture = JSON.parse(output) as Fixture
})

afterAll(async () => {
  if (root) {
    expect(path.dirname(root)).toBe(os.tmpdir())
    expect(path.basename(root).startsWith("raya-upgrade-test-")).toBe(true)
    await rm(root, { recursive: true })
  }
})

function run(raw = fixture.raw, rows = fixture.rows, pins = release, prior = release) {
  return project(
    Buffer.from(raw),
    path.join(root, "next"),
    pins,
    new Map(rows.slice(0, -1).map((row) => [path.join(root, "prior", path.basename(row.path)), row])),
    rows.at(-1)!,
    fixture.directory,
    { path: path.join(root, "prior"), pins: prior },
  )
}

test("upgrade projects actual native file identities without rounding unrelated plan tokens", () => {
  const output = run().toString()
  expect(output).toContain('"retained":{"identity":[18446744073709551615,1791503155482873601]}')
  const plan = JSON.parse(output)
  expect(plan.source).toBe(path.join(root, "next"))
  expect(plan.source_sha256).toEqual(release)
  expect(plan.files).toHaveLength(14)
  expect(plan.directories).toHaveLength(3)
  for (const row of fixture.rows) expect(output).toContain('"identity":[' + row.identity.join(",") + "]")
  const prior = fixture.raw.slice(fixture.raw.indexOf('"directories":'), fixture.raw.indexOf(',"retained":'))
  expect(output).toContain(prior.slice(0, -1) + ",")
})

test("paired Retrieval plan preserves its original source and pin tokens", () => {
  const raw = fixture.raw.replace('"kind":"memory"', '"kind":"retrieval"')
  const output = run(raw).toString()
  const begin = raw.indexOf('"source":')
  const end = raw.indexOf(',"files":')
  expect(output).toContain(raw.slice(begin, end))
  expect(output).toContain('"retained":{"identity":[18446744073709551615,1791503155482873601]}')
})

test("upgrade accepts the exact retained thirteen-file cohort and refuses a mixed historical release", () => {
  const old = "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e"
  const pins = {
    ...release,
    "index.py": old,
    "server.py": "8764ed7600cefb9a33684e06d35ca82df8b408284849fb47442701e9b164443c",
  }
  const raw = fixture.raw.replaceAll(release["index.py"], old).replaceAll(release["server.py"], pins["server.py"])
  expect(JSON.parse(run(raw, fixture.rows, release, pins).toString()).source_sha256).toEqual(release)
  expect(() => run(raw, fixture.rows, release, { ...pins, "server.py": "f".repeat(64) })).toThrow()
})

test("upgrade accepts the exact retained handoff cohort without changing Retrieval selection", () => {
  const pins = {
    ...release,
    "server.py": "deb92041d4cc08c64d64403cb23edfe71221105b2c8094a064aa1e184a168b8b",
    "index.py": "e6f14470dbbe65d1ab6e0c2d0707253b2951bfa6ff529de6e7271c9ba376b5d7",
  }
  const raw = fixture.raw
    .replaceAll(release["server.py"], pins["server.py"])
    .replaceAll(release["index.py"], pins["index.py"])
  expect(JSON.parse(run(raw, fixture.rows, release, pins).toString()).source_sha256).toEqual(release)
  expect(() => run(raw, fixture.rows, release, { ...pins, "index.py": release["index.py"] })).toThrow(
    "Exact previous capture release required",
  )
  const paired = raw.replace('"kind":"memory"', '"kind":"retrieval"')
  const output = run(paired, fixture.rows, release, pins).toString()
  const begin = paired.indexOf('"source":')
  const end = paired.indexOf(',"files":')
  expect(output).toContain(paired.slice(begin, end))
})

test("upgrade refuses altered old bytes, mixed pins and nonordinary native identities", () => {
  expect(() => run(fixture.raw.replace(release["server.py"], "f".repeat(64)))).toThrow()
  expect(() => run(fixture.raw, fixture.rows, { ...release, "index.py": "f".repeat(64) })).toThrow()
  expect(() =>
    run(
      fixture.raw,
      fixture.rows.map((row, index) => (index ? row : { ...row, identity: [...row.identity.slice(0, 5), "2"] })),
    ),
  ).toThrow()
  expect(() =>
    run(
      fixture.raw,
      fixture.rows.map((row, index) =>
        index ? row : { ...row, identity: ["18446744073709551616", ...row.identity.slice(1)] },
      ),
    ),
  ).toThrow()
})

test("upgrade refuses missing, duplicate and already declared source images", () => {
  expect(() => run(fixture.raw, fixture.rows.slice(1))).toThrow()
  const first = JSON.stringify(JSON.parse(fixture.raw).files[0])
  expect(() => run(fixture.raw.replace('"files":[', '"files":[' + first + ","))).toThrow()
  expect(() =>
    run(fixture.raw.replace('"directories":[', '"directories":[' + JSON.stringify(fixture.directory) + ",")),
  ).toThrow()
})

test("upgrade refuses unknown supervisors and rewrites outside the selected new source", () => {
  expect(() =>
    run(
      fixture.raw,
      fixture.rows.map((row, index) =>
        index === fixture.rows.length - 1
          ? { ...row, sha256: "953e159d25e57ac862bd96be56b2b53a2febaf89f2e74628b8a11c92cabceb1b" }
          : row,
      ),
    ),
  ).toThrow()
  expect(() =>
    run(
      fixture.raw,
      fixture.rows.map((row, index) => (index === fixture.rows.length - 1 ? { ...row, sha256: "f".repeat(64) } : row)),
    ),
  ).toThrow()
  expect(() =>
    run(
      fixture.raw,
      fixture.rows.map((row, index) => (index ? row : { ...row, path: path.join(root, "foreign", "server.py") })),
    ),
  ).toThrow()
})
